import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __internals } from './index.js';

const {
  modelGroups,
  resolveModel,
  variantList,
  linkModelDir,
  taskModelDir,
  search,
  canonModel,
  equivCore,
} = __internals;

// 离线测试：禁止任何 alist 访问（兜底逻辑单独在 alist.test.mjs 用假客户端覆盖）
process.env.DSH_ALIST_DISABLE = '1';

const PROJECT_ID = '65a8da81950780b816d12bd9';

/* ------------------------------------------------------------------ *
 * fixture：覆盖 族/变体/别名/噪声 四类情况的迷你看板
 * ------------------------------------------------------------------ */

const task = (id, title, stage, fields, updated = '2026-10-01T00:00:00.000Z') => ({
  id,
  title,
  url: `https://www.teambition.com/task/${id}`,
  stage,
  updated,
  isArchived: false,
  fields,
});

const board = {
  projectId: PROJECT_ID,
  syncedAt: '2026-10-29T00:00:00.000Z',
  items: [
    task(
      't1',
      'CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916',
      '生产库归档',
      {
        机型: ['RK / APOLLO2'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件语言: 'CN',
        固件版本: 'CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916',
        固件下载地址:
          'https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916',
        'OSS 线刷地址':
          'https://minio.cpuniverse.cn/prod/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916/CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916.img',
        'OSS OTA地址':
          'https://minio.cpuniverse.cn/prod/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916/CP_APOLLO2-MIX_A_V1.10_LCD7-12_B1_MDM_20260916_OTA.zip',
      },
    ),
    task(
      't2',
      'SZ_APOLLO2-MIX_A_V1.08_LCD7-12_B1_MDM_20260924',
      '生产库归档',
      {
        机型: ['RK / APOLLO2-12PRO', 'RK / APOLLO2-12PLUS'],
        操作系统: ['Android'],
        客户ID: 'SZ',
        固件语言: 'CN',
        固件版本: 'SZ_APOLLO2-MIX_A_V1.08_LCD7-12_B1_MDM_20260924',
        固件下载地址:
          'https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-MIX/SZ/LCD7-12/SZ_APOLLO2-MIX_A_V1.08_LCD7-12_B1_MDM_20260924',
      },
    ),
    task(
      't3',
      'CP_APOLLO2_A_V1.10_LCD10_B0_MDM_20261001',
      '生产库归档',
      {
        机型: ['RK / APOLLO2'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件语言: 'CN',
        固件版本: 'CP_APOLLO2_A_V1.10_LCD10_B0_MDM_20261001',
        固件下载地址:
          'https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2/CP/LCD10/CP_APOLLO2_A_V1.10_LCD10_B0_MDM_20261001',
      },
    ),
    task(
      't4',
      'CP_SP2-10MIX_A_V1.02_LCD7-12_B1_MDM_20260801',
      '生产库归档',
      {
        机型: ['RK / SPRING2-10MIX'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件版本: 'CP_SP2-10MIX_A_V1.02_LCD7-12_B1_MDM_20260801',
        固件下载地址:
          'https://minio.cpuniverse.cn/prod/RK/ANDROID/SP2-10MIX/CP/LCD7-12/CP_SP2-10MIX_A_V1.02_LCD7-12_B1_MDM_20260801/x.img',
      },
    ),
    task(
      't5',
      'CP_SPRING2-10PRO_A_V1.08_LCD10_B0_MDM_20260701',
      '生产库归档',
      {
        机型: ['RK / SPRING2-10PRO'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件版本: 'CP_SPRING2-10PRO_A_V1.08_LCD10_B0_MDM_20260701',
        固件下载地址:
          'https://next.cpinnov.run/PROD/RK/ANDROID/SP2-10PRO/CP/LCD10/CP_SPRING2-10PRO_A_V1.08_LCD10_B0_MDM_20260701',
      },
    ),
    // MCU 包：/PROD/MCU/<非OS>/...，不能被当成机型目录
    task(
      't6',
      'TANK1_MCU_APP_V2.10_261008_135758',
      '生产库归档',
      {
        机型: ['RK / TANK2'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件版本: 'CP_TANK2_A_V1.09_LCD12_B1_5G_CN_MDM_20260514',
        固件下载地址: 'https://next.cpinnov.run/PROD/MCU/TANK/TANK1_MCU_APP_V2.10_261008_135758',
      },
    ),
    // 在制版本：没有链接，只用于确认不会污染归档结果
    task(
      't7',
      '【版本迭代】CP_APOLLO2-MIX_A_V1.12_LCD7-12_B0',
      '【版本迭代】',
      {
        机型: ['RK / APOLLO2'],
        操作系统: ['Android'],
        客户ID: 'CP',
        固件版本: 'CP_APOLLO2-MIX_A_V1.12_LCD7-12_B0',
      },
      '2026-10-16T00:00:00.000Z',
    ),
    // 7 / 7A / 二代 的写法差异：CP 的 Debian 任务没有链接（V1.12 只在 alist）
    task('t8', 'CP_APOLLO2_D_V1.06_LCD7', '生产库归档', {
      机型: ['RK / APOLLO2-7A'],
      操作系统: ['Debian'],
      客户ID: 'CP',
      固件语言: 'CN',
      固件版本: '',
    }, '2024-10-28T00:00:00.000Z'),
    // MCU 包：机型写法是「瑞芯微 / APOLLO 7 二代」，与 APOLLO2-7A 是同族
    task('t9', 'APOLLO2_MCU_APP_V1.1.0_261020_145106', '生产库归档', {
      机型: ['瑞芯微 / APOLLO 7 二代', '瑞芯微 / APOLLO 7A 二代'],
      操作系统: ['Debian'],
      客户ID: 'CP',
      固件版本: 'APOLLO2_MCU_APP_V1.1.0_261020_145106',
      固件下载地址: 'https://next.cpinnov.run/PROD/MCU/APOLLO2/APOLLO2_MCU_APP_V1.1.0_261020_145106',
    }, '2026-10-23T00:00:00.000Z'),
    // 12 / 12A 是同一族写法；12PRO 不能被吞
    task('t10', 'CP_APOLLO2_A_V1.13_LCD12_B0_20260901', '生产库归档', {
      机型: ['RK / APOLLO2-12A'],
      操作系统: ['Android'],
      客户ID: 'CP',
      固件版本: 'CP_APOLLO2_A_V1.13_LCD12_B0_20260901',
      固件下载地址:
        'https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-12A/CP/LCD12/CP_APOLLO2_A_V1.13_LCD12_B0_20260901',
    }, '2026-09-01T00:00:00.000Z'),
    task('t11', 'CP_APOLLO2-12PRO_A_V1.02_LCD12_B0_20260801', '生产库归档', {
      机型: ['RK / APOLLO2-12PRO'],
      操作系统: ['Android'],
      客户ID: 'CP',
      固件版本: 'CP_APOLLO2-12PRO_A_V1.02_LCD12_B0_20260801',
      固件下载地址:
        'https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-12PRO/CP/LCD12/CP_APOLLO2-12PRO_A_V1.02_LCD12_B0_20260801',
    }, '2026-08-01T00:00:00.000Z'),
  ],
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmware-test-'));
const boardFile = path.join(dir, `board-${PROJECT_ID}.json`);
fs.writeFileSync(boardFile, JSON.stringify(board));
process.env.DSH_TBFW_DIR = dir;

const ok = (name) => console.log(`ok  ${name}`);

try {
  /* ---------------- linkModelDir：只认 PROD 形状 ---------------- */
  assert.deepEqual(
    linkModelDir('https://next.cpinnov.run/PROD/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/CP_APOLLO2-MIX_A_V1.10'),
    { chip: 'RK', model: 'APOLLO2-MIX' },
  );
  assert.deepEqual(
    linkModelDir('https://minio.cpuniverse.cn/prod/T3/ANDROID/SPRING2/CP/LCD7-10/x.img'),
    { chip: 'T3', model: 'SPRING2' },
  );
  ok('linkModelDir 从 PROD 路径取 <chip>/<OS>/<机型>');

  assert.equal(linkModelDir('https://next.cpinnov.run/TEST/RK/ANDROID/APOLLO2-MIX/CP/LCD7-12/x'), null);
  assert.equal(linkModelDir('https://next.cpinnov.run/PRE/RK/ANDROID/APOLLO2-MIX/CP/x'), null);
  assert.equal(linkModelDir('https://next.cpinnov.run/PROD/MCU/TANK/TANK1_MCU_APP_V2.10_261008_135758'), null);
  assert.equal(linkModelDir('https://next.cpinnov.run/PROD/RK/ANDROID'), null);
  assert.equal(linkModelDir('https://mdmobs.cpuniverse.cn/11/spring2/android/CP/x.img'), null);
  assert.equal(linkModelDir('not a url'), null);
  assert.equal(linkModelDir(''), null);
  ok('linkModelDir 拒绝 TEST/PRE、MCU 包、旧 /11/ 形状与非法 URL');

  assert.deepEqual(taskModelDir(board.items[0]), { chip: 'RK', model: 'APOLLO2-MIX' });
  assert.equal(taskModelDir(board.items[6]), null);
  ok('taskModelDir 取第一个可解析的链接');

  /* ---------------- modelGroups：别名 / 变体 / 丢弃 ---------------- */
  const groups = modelGroups(board);
  const byName = (name) => groups.find((g) => g.name === name);

  const apollo = byName('RK / APOLLO2');
  assert.ok(apollo, '缺少 RK / APOLLO2 族');
  assert.equal(apollo.variants.get('apollo2mix')?.label, 'APOLLO2-MIX');
  assert.deepEqual(variantList(apollo), [{ label: 'APOLLO2-MIX', tasks: 2 }]);
  ok('APOLLO2-MIX 作为变体挂在 RK / APOLLO2 下');

  assert.ok(byName('RK / SPRING2-10MIX').aliases.includes('SP2-10MIX'), 'SP2-10MIX 未成为别名');
  ok('SP2-10MIX 通过目录名补成 RK / SPRING2-10MIX 的同族写法');

  assert.ok(
    byName('RK / SPRING2-10PRO').aliases.includes('SP2-10PRO'),
    'SP2-10PRO 未成为别名',
  );
  ok('SP2-10PRO 通过目录名补成 RK / SPRING2-10PRO 的同族写法');

  const allAliases = groups.flatMap((g) => g.aliases);
  assert.ok(!allAliases.includes('PRO'), 'PRO 这类噪声不应成为别名');
  assert.ok(![...groups].some((g) => g.variants.has('pro')), 'PRO 不应成为变体');
  ok('PRO 被丢弃，不产生伪别名/伪变体');

  /* ---------------- resolveModel 优先级 ---------------- */
  const mix = resolveModel('APOLLO2MIX', groups);
  assert.equal(mix.hit?.name, 'RK / APOLLO2');
  assert.equal(mix.variant?.label, 'APOLLO2-MIX');
  ok('resolveModel(APOLLO2MIX) 命中族 + 变体');

  assert.equal(resolveModel('apollo2-mix', groups).variant?.label, 'APOLLO2-MIX');
  ok('resolveModel(apollo2-mix) 同样命中变体');

  const family = resolveModel('APOLLO2', groups);
  assert.equal(family.hit?.name, 'RK / APOLLO2');
  assert.equal(family.variant, undefined, '族名精确命中时不应被变体收窄');
  ok('resolveModel(APOLLO2) 走族路径、不带变体');

  const sp2mix = resolveModel('SP2-10MIX', groups);
  assert.equal(sp2mix.hit?.name, 'RK / SPRING2-10MIX');
  assert.equal(sp2mix.variant, undefined);
  ok('resolveModel(SP2-10MIX) 走族精确命中');

  assert.equal(resolveModel('spring2pro', groups).hit?.name, 'RK / SPRING2-10PRO');
  ok('resolveModel(spring2pro) 仍按省略尺寸规则命中 SPRING2-10PRO');

  assert.equal(resolveModel('ZZZZ9', groups).hit, null);
  ok('未知机型仍返回 needs_confirmation');

  /* ---------------- search：变体查询 ---------------- */
  const started = Date.now();
  const cp = await search({}, {}, { model: 'APOLLO2MIX' });
  const elapsed = Date.now() - started;

  assert.equal(cp.status, 'ok');
  assert.equal(cp.variant, 'APOLLO2-MIX');
  assert.equal(cp.resolvedModel, 'RK / APOLLO2');
  assert.equal(cp.customerDefaulted, true);
  assert.ok(cp.note?.includes('SZ'), 'note 应提示其他客户还有 SZ');
  assert.ok(cp.rows.length >= 1);
  assert.ok(cp.rows.every((r) => r.version.includes('APOLLO2-MIX')));
  assert.ok(cp.rows.every((r) => r.variant === 'APOLLO2-MIX'));
  ok('search(APOLLO2MIX) 默认 CP 只出 MIX 归档行，并提示其他客户');

  const all = await search({}, {}, { model: 'APOLLO2MIX', customer: '*', limit: 5 });
  assert.ok(all.rows.some((r) => r.version.startsWith('SZ_')), 'customer:* 应带出 SZ 行');
  ok('search(APOLLO2MIX, customer:*) 带出其他客户');

  const famQuery = await search({}, {}, { model: 'apollo2', limit: 10 });
  assert.ok(famQuery.rows.some((r) => r.version.includes('LCD10')), '族查询应仍返回 LCD10 版本');
  ok('search(apollo2) 仍是族查询（含 LCD10），未被变体收窄');

  assert.ok(elapsed < 200, `fixture 检索过慢: ${elapsed}ms`);
  ok(`检索耗时 ${elapsed}ms（fixture）`);

  /* ---------------- 等価族：7/7A、12/12A、二代/gen2 ---------------- */
  assert.equal(canonModel('apollo2_7').core, 'apollo7');
  assert.equal(equivCore('apollo7a'), 'apollo7');
  assert.equal(equivCore('apollo7gen2'), 'apollo7');
  assert.equal(equivCore('apollo7agen2'), 'apollo7');
  assert.equal(equivCore('apollo12a'), 'apollo12');
  assert.equal(equivCore('apollo12pro'), 'apollo12pro');
  assert.equal(equivCore('apollo12plus'), 'apollo12plus');
  assert.equal(equivCore('apollo2mix'), 'apollo2mix');
  ok('equivCore 只折叠 gen2 与尾部 A 变体，不吞 12PRO / 12PLUS / MIX');

  const seven = resolveModel('apollo2_7', groups);
  assert.equal(seven.hit?.name, 'RK / APOLLO2-7A', '7 应命中 7A 族');
  assert.ok(seven.hits.length >= 2, '7 / 7A / 二代 应同族命中');
  ok('resolveModel(apollo2_7) 不再 needs_confirmation');

  assert.equal(resolveModel('APOLLO2-7', groups).hit?.name, 'RK / APOLLO2-7A');
  assert.equal(resolveModel('APOLLO2-7A', groups).hit?.name, 'RK / APOLLO2-7A');
  assert.equal(resolveModel('瑞芯微 / APOLLO 7 二代', groups).hit?.name, 'RK / APOLLO2-7A');
  ok('7 / 7A / 二代 三种写法收敛到同一族');

  assert.equal(resolveModel('APOLLO2-12', groups).hit?.name, 'RK / APOLLO2-12A');
  assert.equal(resolveModel('APOLLO2-12A', groups).hit?.name, 'RK / APOLLO2-12A');
  assert.equal(resolveModel('APOLLO2-12PRO', groups).hit?.name, 'RK / APOLLO2-12PRO');
  assert.notEqual(resolveModel('APOLLO2-12A', groups).hit?.name, 'RK / APOLLO2-12PRO');
  ok('12 / 12A 合并，12PRO 保持独立');

  const sevenRows = await search({}, {}, { model: 'apollo2_7', system: 'Debian', all: true });
  assert.equal(sevenRows.status, 'ok');
  assert.ok(sevenRows.matchedFamilies?.length >= 2, '结果应标注等价族');
  assert.ok(
    sevenRows.rows.some((r) => r.version.includes('CP_APOLLO2_D_V1.06')),
    'all=true 应能看到 CP 的无链接 Debian 任务',
  );
  assert.equal(sevenRows.alist, undefined, 'DSH_ALIST_DISABLE=1 时不应访问 alist');
  ok('search(apollo2_7, debian, all) 命中 CP Debian 任务且未触发 alist');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n全部通过');
