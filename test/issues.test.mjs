import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildIssueRows,
  issueOutcome,
  scoreIssue,
  renderIssues,
  syncSubtasks,
  readSubtasks,
} from '../lib/issues.js';

function parent(overrides = {}) {
  return {
    id: 'p1',
    title: '【版本迭代】CP_APOLLO2-7_A_V1.10_LCD7_B0_CN_20260101',
    stage: '生产库归档',
    updated: '2026-01-02T00:00:00.000Z',
    url: 'https://www.teambition.com/task/p1',
    fields: {
      '机型': ['RK / APOLLO2-7'],
      '操作系统': ['Android'],
      '客户ID': ['CP'],
      '固件版本': 'CP_APOLLO2-7_A_V1.10_LCD7_B0_CN_20260101',
    },
    ...overrides,
  };
}

function sub(id, content, isDone, status = '') {
  return {
    id,
    parentId: 'p1',
    content,
    note: '',
    status,
    isDone,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-02T00:00:00.000Z',
    accomplished: isDone ? '2026-01-03T00:00:00.000Z' : '',
    executor: '张三',
    uniqueId: 1,
    url: `https://www.teambition.com/task/${id}`,
  };
}

const records = [
  { subtask: sub('s1', '摄像头热插拔出现断层', true, '验证通过'), parent: parent() },
  { subtask: sub('s2', '蓝牙偶发断连', false, '开发中'), parent: parent() },
  { subtask: sub('s3', '不解决的旧问题', true, '已拒绝'), parent: parent() },
  { subtask: sub('s4', '暂挂起的触摸问题', false, '暂挂起'), parent: parent() },
];

test('issueOutcome 口径：已拒绝/挂起/已解决/待解决', () => {
  assert.equal(issueOutcome(true, '验证通过'), 'solved');
  assert.equal(issueOutcome(false, '开发中'), 'pending');
  assert.equal(issueOutcome(true, '已拒绝'), 'rejected');
  assert.equal(issueOutcome(false, '暂挂起'), 'suspended');
  assert.equal(issueOutcome(undefined, ''), 'unknown');
});

test('buildIssueRows：按版本分组并统计状态', () => {
  const result = buildIssueRows({ records, limit: 5 });
  assert.equal(result.status, 'ok');
  assert.equal(result.summary.versions, 1);
  assert.equal(result.summary.subtasks, 4);
  assert.equal(result.summary.done, 1);
  assert.equal(result.summary.open, 1);
  assert.equal(result.summary.rejected, 1);
  assert.equal(result.summary.suspended, 1);
  const row = result.rows[0];
  assert.equal(row.version, 'CP_APOLLO2-7_A_V1.10_LCD7_B0_CN_20260101');
  assert.equal(row.phase, 'archived');
  assert.equal(row.latestArchived, true);
  assert.equal(row.counts.total, 4);
  assert.equal(row.subtasks[0].outcome, 'pending');
});

test('buildIssueRows：status=open 只留待解决/暂挂起', () => {
  const result = buildIssueRows({ records, status: 'open' });
  assert.equal(result.summary.subtasks, 2);
  assert.deepEqual(result.rows[0].subtasks.map((s) => s.outcome).sort(), ['pending', 'suspended']);
});

test('buildIssueRows：最后一条“完成待验证”仍算待解决', () => {
  const r = [{ subtask: sub('s1', '完成待验证的问题', false, '完成待验证'), parent: parent() }];
  const result = buildIssueRows({ records: r });
  assert.equal(result.rows[0].subtasks[0].outcome, 'pending');
});

test('buildIssueRows：query 命中标题/备注，未命中给低置信候选', () => {
  const hit = buildIssueRows({ records, query: '摄像头断层' });
  assert.equal(hit.status, 'ok');
  assert.equal(hit.summary.subtasks, 1);
  assert.equal(hit.rows[0].subtasks[0].content, '摄像头热插拔出现断层');

  const miss = buildIssueRows({ records, query: 'GNSS 定位漂移' });
  assert.equal(miss.status, 'empty');
  assert.ok(miss.lowConfidence.length > 0);
  assert.ok(miss.notes.some((n) => n.includes('低置信')));
});

test('buildIssueRows：非版本任务（CPDoc）被排除', () => {
  const doc = parent({ id: 'doc', title: '【CPDoc】V1.0.0 release plan', fields: { '机型': ['RK / APOLLO2-7'] } });
  const result = buildIssueRows({
    records: [{ subtask: sub('s1', '文档任务', true, '验证通过'), parent: doc }],
  });
  assert.equal(result.status, 'empty');
});

test('scoreIssue：子串/中文 bigram 命中可过阈值', () => {
  const s = scoreIssue('摄像头断层', { content: '摄像头热插拔出现断层', note: '' });
  assert.ok(s.substring || s.ratio >= 0.45 || s.score >= 120);
  const no = scoreIssue('GNSS 定位漂移', { content: '摄像头热插拔出现断层', note: '' });
  assert.ok(!(no.substring || no.ratio >= 0.45 || no.score >= 120));
});

test('renderIssues：输出状态标签与版本', () => {
  const result = buildIssueRows({ records, status: 'all', customer: 'CP', customerDefaulted: true });
  const text = renderIssues(result);
  assert.match(text, /已解决/);
  assert.match(text, /待解决/);
  assert.match(text, /已拒绝/);
  assert.match(text, /CP_APOLLO2-7_A_V1.10/);
});

test('syncSubtasks：写入、增量跳过、失败保留旧数据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-issues-'));
  const tasks = [
    { id: 'p1', title: '版本1', updated: 't1', subtaskCount: { total: 2, done: 1 } },
    { id: 'p2', title: '版本2', updated: 't2', subtaskCount: { total: 1, done: 0 } },
  ];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.includes('/p2/')) return { status: 500, ok: false, json: async () => ({}) };
    return {
      status: 200,
      ok: true,
      json: async () => ({
        result: [
          { _id: 's1', content: '已解决问题', isDone: true, taskflowstatus: { name: '验证通过' }, updated: '2026-01-01' },
          { _id: 's2', content: '待解决问题', isDone: false, taskflowstatus: { name: '开发中' }, updated: '2026-01-02' },
        ],
      }),
    };
  };

  const first = await syncSubtasks({ dir, projectId: 'pid', tasks, headers: {}, fetchImpl });
  assert.equal(first.items, 2);
  assert.equal(first.fetched, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.failures[0].parent, 'p2');
  const data = readSubtasks(dir, 'pid');
  assert.equal(data.byParent.p1.length, 2);
  assert.equal(data.byParent.p2, undefined);
  assert.equal(data.byParent.p1[0].content, '已解决问题');

  // 第二次：p1 未变化 -> 跳过；p2 继续失败
  const before = calls;
  const second = await syncSubtasks({ dir, projectId: 'pid', tasks, headers: {}, fetchImpl });
  assert.equal(second.skipped, 1);
  assert.equal(calls - before, 1);
  assert.equal(second.failed, 1);

  // force 强制重抓 p1
  const third = await syncSubtasks({ dir, projectId: 'pid', tasks, headers: {}, fetchImpl, force: true });
  assert.equal(third.fetched, 1);
  assert.ok(calls >= 4);
});
