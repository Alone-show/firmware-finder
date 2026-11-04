/**
 * TB 版本任务 / 子任务（待解决、已解决）本地索引与检索。
 *
 * 数据形态：
 *   subtasks-<projectId>.json = { format, projectId, syncedAt, parents:{id:{updated,total,done,fetchedAt,error}}, byParent:{parentId:[subtask]} }
 * 子任务记录只存展示/检索需要的字段；父任务（版本任务）字段仍从 board-*.json 读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nz } from './fix/parse.js';
import { nlScore, bigrams } from './fix/nl.js';

export const SUBTASKS_FORMAT = 1;

const LINK_FIELDS = ['固件下载地址', 'OSS 线刷地址', 'OSS OTA地址', 'OSS 差分包地址'];
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

/** TB 富文本/HTML -> 纯文本，截断，用于匹配与展示 */
export function plainText(input, max = 2000) {
  let s = String(input ?? '');
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

/** 子任务状态 -> 业务口径 */
export function issueOutcome(isDone, status) {
  const st = String(status ?? '');
  if (/拒绝|不解决|不执行/.test(st)) return 'rejected';
  if (/挂起/.test(st)) return 'suspended';
  if (isDone === true) return 'solved';
  if (isDone === false) return 'pending';
  return 'unknown';
}

const OUTCOME_ORDER = { pending: 0, suspended: 1, unknown: 2, solved: 3, rejected: 4 };

export function outcomeLabel(outcome) {
  return { solved: '已解决', pending: '待解决', suspended: '暂挂起', rejected: '已拒绝', unknown: '状态未知' }[outcome] || '状态未知';
}

export function normalizeSubtask(raw, parentId) {
  if (!raw || !raw._id) return null;
  const status = raw.taskflowstatus?.name ?? '';
  return {
    id: raw._id,
    parentId,
    content: String(raw.content ?? '').trim(),
    note: plainText(raw.note ?? '', 2000),
    status,
    isDone: raw.isDone === true,
    created: raw.created ?? '',
    updated: raw.updated ?? '',
    accomplished: raw.accomplished ?? '',
    executor: raw.executor?.name ?? '',
    uniqueId: raw.uniqueId ?? null,
    url: `https://www.teambition.com/task/${raw._id}`,
  };
}

export function isVersionTask(parent) {
  const f = parent?.fields ?? {};
  if (asList(f['固件版本']).length) return true;
  if (String(parent?.title ?? '').includes('【版本迭代】')) return true;
  return LINK_FIELDS.some((key) => asList(f[key]).length);
}

export function linksOf(parent) {
  const out = {};
  for (const key of LINK_FIELDS) {
    const value = asList(parent?.fields?.[key])[0];
    if (value) out[key] = String(value);
  }
  return out;
}

/** 构建日期：优先固件版本字段，其次标题/链接 */
export function versionDate(parent) {
  const f = parent?.fields ?? {};
  const sources = [
    String(asList(f['固件版本'])[0] ?? ''),
    String(parent?.title ?? ''),
    String(asList(f['固件下载地址'])[0] ?? ''),
    String(asList(f['OSS 线刷地址'])[0] ?? ''),
  ];
  for (const src of sources) {
    const m = src.match(/_(20\d{6})(?:_|\.|\/|$)/);
    if (m) return m[1];
  }
  return '';
}

export function stageRank(stage) {
  const st = String(stage ?? '');
  if (st.includes('下架')) return 4;
  if (st.startsWith('生产库归档')) return 0;
  if (st.includes('发布')) return 1;
  return 2;
}

/** 子任务与查询的匹配：nlScore + 查询 bigram 命中率 + 子串加成 */
export function scoreIssue(query, subtask) {
  const q = nz(query);
  const text = nz(`${subtask.content ?? ''} ${subtask.note ?? ''}`);
  if (!q || !text) return { score: 0, hits: [], ratio: 0, substring: false };
  const qb = bigrams(q);
  const tb = new Set(bigrams(text));
  const hits = [...new Set(qb.filter((b) => tb.has(b)))];
  const ratio = qb.length ? hits.length / qb.length : 0;
  const substring = text.includes(q);
  let score = nlScore(query, `${subtask.content ?? ''} ${subtask.note ?? ''}`);
  if (substring) score += 200;
  score += Math.round(ratio * 120);
  return { score, hits: hits.slice(0, 8), ratio, substring };
}

export function issueMatches(query, scored) {
  return scored.substring || scored.ratio >= 0.45 || scored.score >= 120;
}

function pickStatus(records, status) {
  const wanted = String(status ?? 'all').toLowerCase();
  if (wanted === 'all' || !wanted) return records;
  return records.filter((record) => {
    const outcome = issueOutcome(record.subtask.isDone, record.subtask.status);
    if (wanted === 'open') return outcome === 'pending' || outcome === 'suspended' || outcome === 'unknown';
    if (wanted === 'done') return outcome === 'solved';
    if (wanted === 'rejected') return outcome === 'rejected';
    return true;
  });
}

/**
 * 把「子任务 + 父版本任务」记录分组为版本行。
 * 父任务字段已经由调用方归一（local: board item；live: task detail）。
 */
export function buildIssueRows({
  records,
  customer = 'CP',
  customerDefaulted = true,
  otherCustomers = [],
  status = 'all',
  query = '',
  limit = 5,
  subtaskLimit = 30,
  syncedAt = '',
  ageHours = null,
  source = 'index',
  notes = [],
} = {}) {
  const kept = [];
  const lowConfidence = [];
  let queryUsed = String(query ?? '').trim() !== '';
  const q = String(query ?? '').trim();

  for (const record of pickStatus(records ?? [], status)) {
    const parent = record.parent;
    if (!parent || !isVersionTask(parent)) continue;
    const subtask = record.subtask;
    if (q) {
      const scored = scoreIssue(q, subtask);
      if (!issueMatches(q, scored)) {
        lowConfidence.push({ ...subtask, score: scored.score, hits: scored.hits, parent });
        continue;
      }
      kept.push({ ...record, score: scored.score, hits: scored.hits, outcome: issueOutcome(subtask.isDone, subtask.status) });
    } else {
      kept.push({ ...record, score: 0, hits: [], outcome: issueOutcome(subtask.isDone, subtask.status) });
    }
  }

  const groups = new Map();
  for (const record of kept) {
    const parent = record.parent;
    const version = String(asList(parent.fields?.['固件版本'])[0] ?? '') || String(parent.title ?? '') || parent.id;
    const key = version;
    const group = groups.get(key) ?? { version, parent, subtasks: [] };
    // 同版本多任务时保留排序更靠前的父任务（生产库归档优先）
    const prevRank = group.parent ? [stageRank(group.parent.stage), -Number(versionDate(group.parent) || 0)] : null;
    const nextRank = [stageRank(parent.stage), -Number(versionDate(parent) || 0)];
    if (!prevRank || nextRank[0] < prevRank[0] || (nextRank[0] === prevRank[0] && nextRank[1] < prevRank[1])) {
      group.parent = parent;
    }
    if (!group.subtasks.some((s) => s.id === record.subtask.id)) {
      group.subtasks.push(record);
    }
    groups.set(key, group);
  }

  const rows = [...groups.values()];
  const latestArchived = Math.max(
    0,
    ...rows.filter((row) => stageRank(row.parent.stage) === 0).map((row) => Number(versionDate(row.parent) || 0)),
  );

  for (const row of rows) {
    const parent = row.parent;
    const buildDate = versionDate(parent);
    const counts = { total: row.subtasks.length, open: 0, solved: 0, rejected: 0, suspended: 0 };
    for (const item of row.subtasks) {
      if (item.outcome === 'solved') counts.solved += 1;
      else if (item.outcome === 'rejected') counts.rejected += 1;
      else if (item.outcome === 'suspended') counts.suspended += 1;
      else counts.open += 1;
    }
    row.buildDate = buildDate;
    row.stage = parent.stage ?? '';
    row.customer = asList(parent.fields?.['客户ID']).join(', ');
    row.models = asList(parent.fields?.['机型']).join(', ');
    row.system = asList(parent.fields?.['操作系统']).join(', ');
    row.task = parent.url ?? '';
    row.links = linksOf(parent);
    row.phase = stageRank(parent.stage) === 0 ? 'archived' : stageRank(parent.stage) === 1 ? 'published' : 'other';
    row.inProgress = Number(buildDate || 0) > latestArchived && latestArchived > 0;
    row.latestArchived = Number(buildDate || 0) === latestArchived && latestArchived > 0;
    row.counts = counts;
    row.subtasks = row.subtasks
      .sort((a, b) =>
        q
          ? b.score - a.score || String(b.subtask.updated).localeCompare(String(a.subtask.updated))
          : OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome] ||
            String(b.subtask.updated).localeCompare(String(a.subtask.updated)),
      )
      .slice(0, Math.max(1, subtaskLimit))
      .map((item) => ({
        id: item.subtask.id,
        content: item.subtask.content,
        note: item.subtask.note ? item.subtask.note.slice(0, 400) : '',
        status: item.subtask.status,
        isDone: item.subtask.isDone,
        outcome: item.outcome,
        created: item.subtask.created,
        updated: item.subtask.updated,
        accomplished: item.subtask.accomplished,
        executor: item.subtask.executor,
        uniqueId: item.subtask.uniqueId,
        url: item.subtask.url,
        score: item.score ?? 0,
        hits: item.hits ?? [],
      }));
  }

  rows.sort((a, b) => String(b.buildDate).localeCompare(String(a.buildDate)) || stageRank(a.stage) - stageRank(b.stage));
  const picked = rows.slice(0, Math.max(1, limit));
  const allSubs = kept.map((r) => r.subtask);
  const summary = {
    versions: picked.length,
    subtasks: picked.reduce((acc, row) => acc + row.counts.total, 0),
    open: picked.reduce((acc, row) => acc + row.counts.open, 0),
    done: picked.reduce((acc, row) => acc + row.counts.solved, 0),
    rejected: picked.reduce((acc, row) => acc + row.counts.rejected, 0),
    suspended: picked.reduce((acc, row) => acc + row.counts.suspended, 0),
  };

  if (!picked.length) {
    if (q && lowConfidence.length) {
      // 全都不达阈值时，给 3 条低置信候选，避免直接空结果
      lowConfidence.sort((a, b) => b.score - a.score);
      const fallback = lowConfidence.slice(0, 3).map((item) => ({
        content: item.content,
        outcome: issueOutcome(item.isDone, item.status),
        version: String(asList(item.parent.fields?.['固件版本'])[0] ?? '') || item.parent.title,
        buildDate: versionDate(item.parent),
        score: item.score,
        hits: item.hits,
      }));
      return {
        status: 'empty',
        lowConfidence: fallback,
        summary,
        rows: [],
        notes: [...notes, '没有达到阈值的子任务；下面是相似度最高的低置信候选，可换更具体的现象词重试。'],
      };
    }
    return {
      status: 'empty',
      summary,
      rows: [],
      notes: [...notes, q ? '没有匹配的子任务；可换关键词或放宽客户/系统/状态。' : '该机型/客户/系统下没有可用的子任务记录。'],
    };
  }

  return {
    status: 'ok',
    source,
    customer,
    customerDefaulted,
    otherCustomers,
    syncedAt,
    ...(Number.isFinite(ageHours) ? { ageHours } : {}),
    summary,
    lowConfidence: [],
    pending: [],
    rows: picked,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * 子任务同步
 * ------------------------------------------------------------------ */

function subtasksFile(dir, projectId) {
  return path.join(dir, `subtasks-${projectId}.json`);
}

let subtasksCache = { file: null, mtimeMs: 0, data: null };

export function readSubtasks(dir, projectId) {
  const file = subtasksFile(dir, projectId);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (subtasksCache.file === file && subtasksCache.mtimeMs === st.mtimeMs) return subtasksCache.data;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.format !== SUBTASKS_FORMAT || !data.byParent) return null;
    subtasksCache = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

async function fetchPaged(headers, url, pick, fetchImpl, maxPages = 20) {
  const out = [];
  let token = '';
  for (let i = 0; i < maxPages; i += 1) {
    const full = `${url}${url.includes('?') ? '&' : '?'}pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const res = await fetchImpl(full, { headers });
    if (res.status === 401) throw new Error('Teambition 登录态失效，需要重新登录（/firmware login）');
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    const json = await res.json();
    out.push(...pick(json));
    if (!json.nextPageToken) break;
    token = json.nextPageToken;
  }
  return out;
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 抓取父任务的子任务。只抓 subtaskCount.total > 0 的父任务；未变化时复用旧记录。
 * @returns {{file,parents,items,fetched,skipped,failed,failures,syncedAt}}
 */
export async function syncSubtasks({
  dir,
  projectId,
  tasks,
  headers,
  fetchImpl = globalThis.fetch,
  force = false,
  concurrency = 8,
  onProgress,
} = {}) {
  const old = readSubtasks(dir, projectId);
  const parents = (tasks ?? []).filter((t) => Number(t.subtaskCount?.total ?? 0) > 0);
  const meta = { ...(old?.parents ?? {}) };
  const byParent = { ...(old?.byParent ?? {}) };
  const stats = { fetched: 0, skipped: 0, failed: 0 };
  const failures = [];

  await mapPool(parents, concurrency, async (task) => {
    const total = Number(task.subtaskCount?.total ?? 0);
    const done = Number(task.subtaskCount?.done ?? 0);
    const prev = meta[task.id];
    if (!force && prev && prev.updated === task.updated && prev.total === total && prev.done === done && byParent[task.id]) {
      stats.skipped += 1;
      return;
    }
    try {
      const raw = await fetchPaged(
        headers,
        `https://www.teambition.com/api/v2/tasks/${task.id}/subtasks`,
        (json) => json.result ?? [],
        fetchImpl,
      );
      byParent[task.id] = raw.map((item) => normalizeSubtask(item, task.id)).filter(Boolean);
      meta[task.id] = { updated: task.updated ?? '', total, done, fetchedAt: new Date().toISOString(), error: '' };
      stats.fetched += 1;
    } catch (error) {
      stats.failed += 1;
      const message = error?.message || String(error);
      failures.push({ parent: task.id, title: task.title, error: message });
      if (meta[task.id]) meta[task.id] = { ...meta[task.id], fetchedAt: new Date().toISOString(), error: message };
      else meta[task.id] = { updated: task.updated ?? '', total, done, fetchedAt: '', error: message };
    }
    onProgress?.({ fetched: stats.fetched, skipped: stats.skipped, failed: stats.failed, total: parents.length });
  });

  // 清掉已不再有子任务的父任务
  for (const id of Object.keys(byParent)) {
    if (!parents.some((task) => task.id === id)) {
      delete byParent[id];
      delete meta[id];
    }
  }

  const data = {
    format: SUBTASKS_FORMAT,
    projectId,
    syncedAt: new Date().toISOString(),
    parents: meta,
    byParent,
  };
  const file = subtasksFile(dir, projectId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  subtasksCache = { file: null, mtimeMs: 0, data: null };

  return {
    file,
    parents: parents.length,
    items: Object.values(byParent).reduce((acc, list) => acc + list.length, 0),
    ...stats,
    failures,
    syncedAt: data.syncedAt,
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

export function renderIssues(result) {
  if (result.status === 'needs_sync') return `还没有 TB 子任务索引。${result.hint || ''}`;
  if (result.status === 'needs_setup') return `还没有 TB 看板索引。${result.hint || ''}`;
  if (result.status === 'needs_model') return `请补充机型。${result.hint || ''}`;
  if (result.status === 'needs_auth') return `需要 Teambition 登录。${result.hint || ''}`;
  if (result.status === 'error') return `firmware_issues 出错：${result.message}`;
  if (result.status === 'needs_confirmation') {
    const lines = [`机型「${result.query || result.resolvedModel || '-'}」无法唯一确定，需要用户确认：`, ''];
    for (const c of result.candidates || []) {
      const alias = c.aliases?.length ? `  (同族写法: ${c.aliases.join(' / ')})` : '';
      const vs = c.variants?.length ? `  变体: ${c.variants.map((x) => `${x.label}(${x.tasks})`).join(' / ')}` : '';
      lines.push(`- ${c.model}  [${c.score} 分, ${c.tasks} 个任务]${alias}${vs}`);
    }
    if (result.note) lines.push('', result.note);
    lines.push('', '请让用户选定一个后用 /firmware 重发，不要自行猜测。');
    return lines.join('\n');
  }

  const lines = [];
  const scope = [result.resolvedModel || result.query || '-', result.system || result.requestedSystem || '全部系统', `客户 ${result.customer || 'CP'}${result.customerDefaulted ? '（默认）' : ''}`];
  lines.push(`范围：${scope.join(' | ')}`);
  if (result.otherCustomers?.length) {
    lines.push(`其他客户还有：${result.otherCustomers.map((c) => `${c.customer}(${c.count})`).join('、')}`);
  }

  if (result.status === 'empty') {
    lines.push('', '没有匹配的子任务。');
    for (const item of result.lowConfidence || []) {
      lines.push(`  低置信：${item.content}（${item.version}，${item.buildDate || '-'}，${item.score} 分）`);
    }
    for (const note of result.notes || []) lines.push(`· ${note}`);
    return lines.join('\n');
  }

  const s = result.summary || {};
  lines.push(
    `共 ${s.versions ?? 0} 个版本 / ${s.subtasks ?? 0} 个子任务：已解决 ${s.done ?? 0}，待解决 ${s.open ?? 0}，已拒绝 ${s.rejected ?? 0}${s.suspended ? `，暂挂起 ${s.suspended}` : ''}`,
  );
  lines.push('');

  for (const row of result.rows || []) {
    const phase = row.inProgress ? '在制' : row.phase === 'archived' ? '生产库归档' : row.stage || '-';
    lines.push(`[${row.version}] ${phase} | 构建 ${row.buildDate || '-'} | 客户 ${row.customer || '-'}`);
    if (row.models || row.system) lines.push(`    机型 ${row.models || '-'} | 系统 ${row.system || '-'}`);
    if (row.links?.['OSS 线刷地址']) lines.push(`    线刷：${row.links['OSS 线刷地址']}`);
    if (row.links?.['OSS OTA地址']) lines.push(`    OTA：${row.links['OSS OTA地址']}`);
    if (row.task) lines.push(`    任务：${row.task}`);
    for (const item of row.subtasks || []) {
      const tag = outcomeLabel(item.outcome);
      const score = item.score ? ` [${item.score} 分]` : '';
      const hit = item.hits?.length ? `（命中：${item.hits.slice(0, 5).join('/')}）` : '';
      lines.push(`    - [${tag}] ${item.content}${score}${hit}${item.executor ? `（${item.executor}，${(item.accomplished || item.updated || '').slice(0, 10)}）` : ''}`);
    }
    lines.push('');
  }

  for (const note of result.notes || []) lines.push(`· ${note}`);
  if (result.ageHours !== null && result.ageHours !== undefined) {
    lines.push(`索引：${Number(result.ageHours).toFixed(1)} 小时前${result.ageHours > 72 ? '（已过期，建议 /firmware sync）' : ''}`);
  }
  return lines.join('\n').trim();
}
