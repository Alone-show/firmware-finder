import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __internals } from './index.js';
import { createAlist, parseVersionDir } from './alist.js';

const {
  collectAlistRows,
  mergeAlistRows,
  matchModelDir,
  lcdFromCores,
  mapCustomerDir,
  search,
  setAlistFactory,
} = __internals;

delete process.env.DSH_ALIST_DISABLE;

const ok = (name) => console.log(`ok  ${name}`);

/* ------------------------------------------------------------------ *
 * fixture：CP / YMZH / SMARTAG 三条 Debian 线的迷你 alist 目录树
 * ------------------------------------------------------------------ */

const dir = (name, modified = '2026-08-05T12:37:15.000Z') => ({
  name,
  isDir: true,
  size: 0,
  modified,
});
const file = (name, size) => ({
  name,
  isDir: false,
  size,
  modified: '',
  rawUrl: `https://alist.example/dl/${encodeURIComponent(name)}?sign=sig`,
  sign: 'sig',
});

const CP_V112 = 'CP_APOLLO2_D_V1.12_LCD7_B1_CN_20260805';
const CP_V111 = 'CP_APOLLO2_D_V1.11_LCD7_B1_CN_20260610';
const YM_V107 = 'YMZH_APOLLO2_D_V1.07_LCD7_B1_CN_20241021';
const SG_V103 = 'SMARTAG_APOLLO2-7A_D_V1.03_LCD7_B1_EU_20240528';

const TREE = {
  '/PROD': [dir('RK')],
  '/PROD/RK': [dir('DEBIAN'), dir('ANDROID')],
  '/PROD/RK/DEBIAN': [dir('APOLLO2'), dir('APOLLO2-7A')],
  '/PROD/RK/DEBIAN/APOLLO2': [dir('CP'), dir('YMZH')],
  '/PROD/RK/DEBIAN/APOLLO2/CP': [dir('LCD7')],
  '/PROD/RK/DEBIAN/APOLLO2/CP/LCD7': [dir(CP_V112, '2026-08-05T12:37:15.000Z'), dir(CP_V111, '2026-06-10T13:31:08.000Z')],
  '/PROD/RK/DEBIAN/APOLLO2/YMZH': [dir('LCD7')],
  '/PROD/RK/DEBIAN/APOLLO2/YMZH/LCD7': [dir(YM_V107, '2024-10-21T15:09:16.000Z')],
  '/PROD/RK/DEBIAN/APOLLO2-7A': [dir('SMARTAG')],
  '/PROD/RK/DEBIAN/APOLLO2-7A/SMARTAG': [dir('LCD7')],
  '/PROD/RK/DEBIAN/APOLLO2-7A/SMARTAG/LCD7': [dir(SG_V103, '2024-06-03T06:01:10.000Z')],
  '/PROD/RK/ANDROID': [dir('APOLLO2')],
};

const ENTRIES = {
  [`/PROD/RK/DEBIAN/APOLLO2/CP/LCD7/${CP_V112}/${CP_V112}.img`]: file(`${CP_V112}.img`, 3234992714),
  [`/PROD/RK/DEBIAN/APOLLO2/CP/LCD7/${CP_V112}/${CP_V112}_OTA.img`]: file(`${CP_V112}_OTA.img`, 3180659274),
  [`/PROD/RK/DEBIAN/APOLLO2-7A/SMARTAG/LCD7/${SG_V103}/${SG_V103}.img`]: file(`${SG_V103}.img`, 1000),
};

function makeFakeAlist() {
  const fake = {
    calls: [],
    stats: { requests: 0, cacheHits: 0 },
    base: 'https://alist.example',
    pageUrl: (p) => `https://alist.example${p}`,
    async list(p) {
      fake.stats.requests += 1;
      fake.calls.push(['list', p]);
      return TREE[p] ?? null;
    },
    async entry(p) {
      fake.stats.requests += 1;
      fake.calls.push(['entry', p]);
      return ENTRIES[p] ?? null;
    },
    async text() {
      return '';
    },
  };
  return fake;
}

/* ------------------------------------------------------------------ *
 * 1) 版本目录名解析
 * ------------------------------------------------------------------ */
{
  const cp = parseVersionDir(CP_V112);
  assert.deepEqual(
    { customer: cp.customer, product: cp.product, osLetter: cp.osLetter, version: cp.version, lcd: cp.lcd, board: cp.board, region: cp.region, date: cp.date },
    { customer: 'CP', product: 'APOLLO2', osLetter: 'D', version: 'V1.12', lcd: 'LCD7', board: 'B1', region: 'CN', date: '20260805' },
  );
  ok('parseVersionDir 解析 CP_APOLLO2_D_V1.12_LCD7_B1_CN_20260805');

  const sg = parseVersionDir(SG_V103);
  assert.equal(sg.customer, 'SMARTAG');
  assert.equal(sg.product, 'APOLLO2-7A');
  assert.equal(sg.region, 'EU');
  ok('parseVersionDir 兼容大小写混写（SmartAG/SMARTAG）');

  const patch = parseVersionDir('CP_APOLLO2_D_V1.08.1_LCD7_B1_CN_20250303');
  assert.equal(patch.version, 'V1.08.1');
  ok('parseVersionDir 兼容 V1.08.1');

  const cellular = parseVersionDir('SmartAG_APOLLO2-7A_D_V1.01_LCD7_B1_4G_CN_20240402');
  assert.equal(cellular.cellular, '4G');
  assert.equal(cellular.region, 'CN');
  assert.equal(cellular.customer, 'SmartAG');
  ok('parseVersionDir 识别 4G 与地区');

  assert.equal(parseVersionDir('README.md'), null);
  assert.equal(parseVersionDir('LCD7'), null);
  ok('parseVersionDir 拒绝非版本目录');
}

/* ------------------------------------------------------------------ *
 * 2) 目录匹配 / 客户映射 / 尺寸
 * ------------------------------------------------------------------ */
{
  assert.equal(matchModelDir('APOLLO2', ['apollo7a']), 70);
  assert.equal(matchModelDir('APOLLO2-7A', ['apollo7a']), 100);
  assert.equal(matchModelDir('APOLLO2-12PRO', ['apollo7a']), 0);
  ok('matchModelDir：族目录 70 分、精确 100 分、12PRO 不误配');

  assert.equal(mapCustomerDir('YMZH'), 'YM');
  assert.equal(mapCustomerDir('SmartAG'), 'SmartAG');
  assert.equal(mapCustomerDir('SMARTAG'), 'SmartAG');
  assert.equal(mapCustomerDir('Unknown'), 'Unknown');
  ok('mapCustomerDir 映射已知客户、未知客户原样保留');

  assert.equal(lcdFromCores(['apollo7a']), 'LCD7');
  assert.equal(lcdFromCores(['apollo12a']), 'LCD12');
  assert.equal(lcdFromCores(['apollo']), '');
  ok('lcdFromCores 从等价 core 推尺寸');
}

/* ------------------------------------------------------------------ *
 * 3) collectAlistRows：默认 CP、LCD 过滤、链接与其它客户
 * ------------------------------------------------------------------ */
{
  const fake = makeFakeAlist();
  const collected = await collectAlistRows(fake, {
    cores: ['apollo7a'],
    vendor: 'rk',
    system: 'Debian',
    customer: 'CP',
    limit: 5,
  });
  assert.equal(collected.ok, true);
  assert.equal(collected.rows.length, 2, 'CP 下应有两个 Debian 版本');

  const latest = collected.rows[0];
  assert.equal(latest.version, CP_V112);
  assert.equal(latest.source, 'alist');
  assert.equal(latest.buildDate, '20260805');
  assert.equal(latest.system, 'Debian');
  assert.equal(latest.customer, 'CP');
  assert.equal(latest.lcd, 'LCD7');
  assert.equal(latest.size, 3234992714);
  assert.equal(latest.links['固件下载地址'], `https://alist.example/PROD/RK/DEBIAN/APOLLO2/CP/LCD7/${CP_V112}`);
  assert.ok(latest.links['OSS 线刷地址']?.includes('.img'), '应给出带 sign 的线刷直链');
  assert.ok(latest.links['OSS OTA地址']?.includes('_OTA.img'), '应给出 OTA 直链');
  assert.equal(latest.artifacts.img.name, `${CP_V112}.img`);
  ok('collectAlistRows 默认 CP 命中 V1.12，带 img/OTA 直链与体积');

  const versions = collected.rows.map((r) => r.version);
  assert.ok(!versions.includes(YM_V107), '默认 CP 不应混入 YM 的包');
  assert.ok(!versions.includes(SG_V103), '默认 CP 不应混入 SmartAG 的包');
  const others = collected.otherCustomers.map((x) => x.customer);
  assert.ok(others.includes('YM'), '应列出其它客户 YM');
  assert.ok(others.includes('SmartAG'), '应列出其它客户 SmartAG');
  ok('collectAlistRows 默认 CP 过滤 + 列出其它客户');

  const onlyOne = await collectAlistRows(fake, { cores: ['apollo7a'], vendor: 'rk', system: 'Debian', customer: 'CP', limit: 1 });
  assert.equal(onlyOne.rows.length, 1);
  assert.equal(onlyOne.rows[0].version, CP_V112, '按构建日期倒序，最新在前');
  ok('collectAlistRows 尊重 limit 且按日期倒序');

  const all = await collectAlistRows(fake, { cores: ['apollo7a'], vendor: 'rk', system: 'Debian', customer: '', limit: 5 });
  assert.ok(all.rows.some((r) => r.version === YM_V107));
  assert.ok(all.rows.some((r) => r.version === SG_V103));
  ok('collectAlistRows customer=\'\' 时不限客户');
}

/* ------------------------------------------------------------------ *
 * 4) 与 Teambition 行合并
 * ------------------------------------------------------------------ */
{
  const tbRows = [
    { version: CP_V112, customer: 'CP', buildDate: '20260805', links: {}, source: undefined },
    { version: 'CP_APOLLO2_D_V1.06_LCD7', customer: 'CP', buildDate: '', links: {} },
  ];
  const alistRows = [
    { version: CP_V112, customer: 'CP', buildDate: '20260805', links: { 'OSS 线刷地址': 'u' }, size: 10, lcd: 'LCD7' },
  ];
  const merged = mergeAlistRows(tbRows, alistRows);
  assert.equal(merged.length, 2, '同版本应合并成一行');
  assert.equal(merged[0].source, 'both');
  assert.equal(merged[0].links['OSS 线刷地址'], 'u');
  assert.equal(merged[1].source, 'teambition');
  ok('mergeAlistRows 同版本合并且以 Teambition 行为主');
}

/* ------------------------------------------------------------------ *
 * 5) createAlist：注入 transport、缓存、失败降级
 * ------------------------------------------------------------------ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alist-client-'));
  const cacheFile = path.join(tmp, 'alist-cache.json');
  let calls = 0;
  const transport = async ({ url }) => {
    calls += 1;
    if (url.endsWith('/api/fs/list')) {
      return {
        status: 200,
        json: { code: 200, data: { content: [{ name: 'CP', is_dir: true, size: 0, modified: '2026-08-05T00:00:00Z' }], total: 1 } },
      };
    }
    if (url.endsWith('/api/fs/get')) {
      return {
        status: 200,
        json: { code: 200, data: { name: 'x.img', size: 123, is_dir: false, sign: 's', raw_url: 'https://alist.example/dl/x.img' } },
      };
    }
    return null;
  };
  const alist = createAlist({ base: 'https://alist.example', cacheFile, transport });
  const first = await alist.list('/PROD/RK');
  assert.equal(first.length, 1);
  assert.equal(first[0].isDir, true);
  assert.equal(alist.stats.requests, 1);
  const second = await alist.list('/PROD/RK');
  assert.equal(second.length, 1);
  assert.equal(alist.stats.requests, 1, '第二次应命中缓存');
  ok('createAlist 列表 + 缓存命中');

  const meta = await alist.entry('/PROD/RK/x.img');
  assert.equal(meta.size, 123);
  assert.equal(meta.rawUrl, 'https://alist.example/dl/x.img');
  ok('createAlist 取单条元数据（含 signed raw_url）');

  const broken = createAlist({ base: 'https://alist.example', transport: async () => null, timeoutMs: 5 });
  assert.equal(await broken.list('/PROD'), null);
  assert.equal(await broken.entry('/PROD/x.img'), null);
  ok('createAlist 失败静默降级为 null');

  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 6) search 兜底集成：Teambition 无链接 -> alist 兜底；source=tb 不碰 alist
 * ------------------------------------------------------------------ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmware-alist-'));
  const PROJECT_ID = '65a8da81950780b816d12bd9';
  const board = {
    projectId: PROJECT_ID,
    syncedAt: '2026-10-29T00:00:00.000Z',
    items: [
      {
        id: 't1',
        title: 'CP_APOLLO2_D_V1.06_LCD7',
        url: 'https://www.teambition.com/task/t1',
        stage: '生产库归档',
        updated: '2024-10-28T00:00:00.000Z',
        isArchived: false,
        fields: { 机型: ['RK / APOLLO2-7A'], 操作系统: ['Debian'], 客户ID: 'CP', 固件语言: 'CN' },
      },
    ],
  };
  fs.writeFileSync(path.join(tmp, `board-${PROJECT_ID}.json`), JSON.stringify(board));
  process.env.DSH_TBFW_DIR = tmp;

  const fake = makeFakeAlist();
  setAlistFactory(() => fake);

  const auto = await search({}, {}, { model: 'APOLLO2-7', system: 'Debian' });
  assert.equal(auto.status, 'ok');
  assert.equal(auto.alist?.ok, true);
  assert.equal(auto.rows[0].version, CP_V112);
  assert.equal(auto.rows[0].source, 'alist');
  assert.ok(auto.note?.includes('alist'), 'note 应说明结果来自 alist');
  assert.ok(auto.otherCustomers.some((x) => x.customer === 'YM'));
  ok('search 自动兜底：Teambition 无链接时用 alist 返回 V1.12');

  fake.calls.length = 0;
  const tbOnly = await search({}, {}, { model: 'APOLLO2-7', system: 'Debian', source: 'tb' });
  assert.equal(tbOnly.status, 'empty');
  assert.equal(fake.calls.length, 0, 'source=tb 不应触碰 alist');
  ok('search(source=tb) 不访问 alist，保持旧行为');

  const alistOnly = await search({}, {}, { model: 'APOLLO2-7', system: 'Debian', source: 'alist' });
  assert.ok(alistOnly.rows.every((r) => r.source === 'alist'));
  ok('search(source=alist) 只返回 alist 行');

  setAlistFactory((options) => createAlist(options));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 7) MCU 包不算「整机固件」：只有 MCU 链接时仍要触发 alist 兜底
 * ------------------------------------------------------------------ */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmware-mcu-'));
  const PROJECT_ID = '65a8da81950780b816d12bd9';
  const board = {
    projectId: PROJECT_ID,
    syncedAt: '2026-10-29T00:00:00.000Z',
    items: [
      {
        id: 'mcu',
        title: 'APOLLO2_MCU_APP_V1.1.0_261020_145106',
        url: 'https://www.teambition.com/task/mcu',
        stage: '生产库归档',
        updated: '2026-10-23T00:00:00.000Z',
        isArchived: false,
        fields: {
          机型: ['瑞芯微 / APOLLO 7 二代', '瑞芯微 / APOLLO 7A 二代'],
          操作系统: ['Debian'],
          客户ID: 'CP',
          固件版本: 'APOLLO2_MCU_APP_V1.1.0_261020_145106',
          固件下载地址: 'https://next.cpinnov.run/PROD/MCU/APOLLO2/APOLLO2_MCU_APP_V1.1.0_261020_145106',
        },
      },
    ],
  };
  fs.writeFileSync(path.join(tmp, `board-${PROJECT_ID}.json`), JSON.stringify(board));
  process.env.DSH_TBFW_DIR = tmp;
  setAlistFactory(() => makeFakeAlist());

  const result = await search({}, {}, { model: 'APOLLO2-7', system: 'Debian', limit: 5 });
  assert.equal(result.status, 'ok');
  assert.ok(
    result.rows.some((r) => r.source === 'alist' && r.version === CP_V112),
    '只有 MCU 链接时也应兜底到 alist 的整机固件',
  );
  assert.ok(result.rows.some((r) => r.version.startsWith('APOLLO2_MCU_APP')), 'MCU 行仍保留');
  ok('MCU 包不算整机固件，仍触发 alist 兜底');

  setAlistFactory((options) => createAlist(options));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n全部通过');
