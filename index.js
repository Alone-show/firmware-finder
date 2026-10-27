import fs from 'node:fs';
import path from 'node:path';
import { checkToken, ensureToken, loginWithCookie, discoverBrowsers, tokenFile } from './login.js';

const PROJECT_ID = '65a8da81950780b816d12bd9'; // 【研发部】CI/CD 发版流程
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

/* ------------------------------------------------------------------ *
 * 归档字段
 * ------------------------------------------------------------------ */

const LINK_FIELDS = ['固件下载地址', 'OSS 线刷地址', 'OSS OTA地址', 'OSS 差分包地址'];

const nz = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const VENDOR = {
  rk: 'rk', 瑞芯微: 'rk',
  t3: 't3',
  sc60: 'sc60',
  全志: 'allwinner',
  高通: 'qualcomm',
};

/** 机型字符串 -> {vendor, core}；只有 Apollo2 一族允许折叠，SPRING/SPRING2、一代/二代 不折叠 */
function vendorKey(token) {
  const t = String(token ?? '').trim();
  return VENDOR[t.toLowerCase()] ?? VENDOR[t] ?? '';
}

/** 供应商可能写成 T3 / X、T3 X、T3-X、X（T3）；只认已知供应商，避免把型号当前缀 */
function splitVendor(raw) {
  const s = String(raw ?? '').trim();
  const paren = s.match(/^(.+?)\s*[（(]\s*([^)）]+?)\s*[)）]$/);
  if (paren) {
    const v = vendorKey(paren[2]);
    if (v) return { vendor: v, rest: paren[1].trim() };
  }
  const parts = s.split(/[/／]/);
  if (parts.length >= 2) {
    const v = vendorKey(parts[0]);
    if (v) return { vendor: v, rest: parts.slice(1).join('/').trim() };
  }
  const dashed = s.match(/^([A-Za-z0-9\u4e00-\u9fa5]{2,7})\s*[-_\s]\s*(.+)$/);
  if (dashed) {
    const v = vendorKey(dashed[1]);
    if (v) return { vendor: v, rest: dashed[2].trim() };
  }
  return { vendor: '', rest: s };
}

function canonModel(input) {
  const { vendor, rest } = splitVendor(input);
  const core = nz(rest.replace(/二代/g, 'gen2')).replace(/apollo2/g, 'apollo');
  return { vendor, core };
}

function modelGroups(board) {
  const counts = new Map();
  for (const t of board.items) {
    const v = t.fields?.['机型'];
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x) counts.set(String(x), (counts.get(String(x)) ?? 0) + 1);
    }
  }
  const groups = new Map();
  for (const [name, cnt] of counts) {
    const { vendor, core } = canonModel(name);
    const key = `${vendor}\u0000${core}`;
    const g = groups.get(key) ?? { vendor, core, names: [], count: 0 };
    g.names.push([cnt, name]);
    g.count += cnt;
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    g.names.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    g.name = g.names[0][1];
    g.aliases = g.names.slice(1).map((n) => n[1]);
    out.push(g);
  }
  return out;
}

/** 查询侧的缩写展开：SP2 <-> SPRING2、APOLLO <-> APOLLO2，让路径式写法也能命中字段全称 */
function queryCores(qc) {
  const cores = new Set([qc]);
  for (const [a, b] of [
    ['sp2', 'spring2'],
    ['spring2', 'sp2'],
    ['apollo2', 'apollo'],
    ['apollo', 'apollo2'],
  ]) {
    if (qc.includes(a)) cores.add(qc.replaceAll(a, b));
  }
  return [...cores];
}

/**
 * 查询省略了型号里的尺寸数字段时仍应命中：spring2pro -> spring210pro。
 * 约束：查询以字母结尾（pro/plus/mix），字母骨架相同，且核心数字更多。
 * 加这些约束是为了不让 apollo10 这类以数字结尾的真实型号被误判。
 */
function gapScore(qc, core) {
  if (!/[a-z]$/.test(qc)) return 0;
  const qLetters = qc.replace(/\d/g, '');
  const cLetters = core.replace(/\d/g, '');
  if (!qLetters || qLetters !== cLetters) return 0;
  const qDigits = (qc.match(/\d/g) ?? []).length;
  const cDigits = (core.match(/\d/g) ?? []).length;
  return cDigits > qDigits ? 85 : 0;
}

function scoreCore(qc, g) {
  if (g.core === qc) return 100;
  if (g.core.startsWith(qc)) return 70;
  if (g.core.includes(qc)) return 50;
  if (qc.includes(g.core)) {
    // spring2 不该匹配 spring：只有当多出来的部分是字母（如 5g）时才算同一族
    if (/[a-z]/.test(qc.split(g.core).join(''))) return 40;
  }
  const gap = gapScore(qc, g.core);
  if (gap) return gap;
  const qt = new Set(qc.match(/[a-z]+|\d+/g) ?? []);
  const gt = new Set(g.core.match(/[a-z]+|\d+/g) ?? []);
  const inter = [...qt].filter((x) => gt.has(x));
  return inter.length >= 2 ? 20 + 5 * inter.length : 0;
}

function resolveModel(query, groups) {
  const { vendor: qv, core: qc } = canonModel(query);
  if (!qc) return { hit: null, scored: [] };
  const cores = queryCores(qc);
  const scored = [];
  for (const g of groups) {
    let score = Math.max(...cores.map((c) => scoreCore(c, g)));
    if (qv && g.vendor === qv) score += 10;
    else if (qv && g.vendor && g.vendor !== qv) score -= 10;
    if (score >= 40) scored.push([score, g]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  const top = scored[0];
  if (top) {
    // 只有同样强的竞争者（另一个精确/省略尺寸命中）才阻断；纯前缀不算
    const rivals = scored.slice(1).filter(([sc]) => sc >= 85);
    if (rivals.length === 0 && top[0] >= 95 && (!qv || top[1].vendor === qv)) {
      return { hit: top[1], scored };
    }
    if (rivals.length === 0 && top[0] >= 85) return { hit: top[1], scored };
  }
  return { hit: null, scored };
}

/** 路径里的缩写（SP2 / APOLLO）要能命中字段里的全称（SPRING2 / APOLLO2） */
function modelVariants(model) {
  const base = nz(model);
  const v = new Set([base]);
  if (base.includes('apollo2')) v.add(base.replaceAll('apollo2', 'apollo'));
  else if (base.includes('apollo')) v.add(base.replaceAll('apollo', 'apollo2'));
  if (base.includes('spring2')) v.add(base.replaceAll('spring2', 'sp2'));
  if (base.includes('sp2')) v.add(base.replaceAll('sp2', 'spring2'));
  return [...v].filter(Boolean);
}

const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

function linksOf(task) {
  const out = {};
  for (const k of LINK_FIELDS) {
    const v = asList(task.fields?.[k])[0];
    if (v) out[k] = String(v);
  }
  return out;
}

/** 构建日期：字段缺版本号时，从标题或下载地址里捞（在制版本常常只有链接） */
function versionDate(task) {
  const f = task.fields ?? {};
  const sources = [
    String(f['固件版本'] || ''),
    String(task.title || ''),
    String(f['固件下载地址'] || ''),
    String(f['OSS 线刷地址'] || ''),
  ];
  for (const src of sources) {
    const m = src.match(/_(20\d{6})(?:_|\.|\/|$)/);
    if (m) return m[1];
  }
  return '';
}

/** 阶段优先级：只有「生产库归档」才算正式归档；「自归档」「归档-下架」不算 */
function stageRank(stage) {
  const st = String(stage ?? '');
  if (st.includes('下架')) return 4;
  if (st.startsWith('生产库归档')) return 0;
  if (st.includes('发布')) return 1;
  return 2;
}

function rankKey(task) {
  const st = String(task.stage ?? '');
  const prio = stageRank(st);
  // 构建日期优先于 updated：补建的旧版本任务更新更晚，但固件更老
  const build = Number(versionDate(task) || 0);
  const ts = Date.parse(task.updated ?? '') || 0;
  return [prio, -build, -ts];
}

function hitModel(task, variants) {
  const f = task.fields ?? {};
  const hay = nz(
    [
      task.title ?? '',
      asList(f['机型']).join(' '),
      f['固件版本'] ?? '',
      f['固件下载地址'] ?? '',
      f['OSS 线刷地址'] ?? '',
    ].join(' '),
  );
  return variants.some((v) => hay.includes(v));
}

/** 看板里的操作系统只有 Android / Debian / BuildRoot；Linux 指代后两者 */
const SYSTEM_ALIASES = {
  linux: ['debian', 'buildroot'],
  'linux 系统': ['debian', 'buildroot'],
  gnulinux: ['debian', 'buildroot'],
  android: ['android'],
  安卓: ['android'],
  debian: ['debian'],
  buildroot: ['buildroot'],
};

function hitSystem(task, system, mainline) {
  const f = task.fields ?? {};
  const osList = asList(f['操作系统']).map(String);
  const q = String(system ?? '').trim().toLowerCase();
  const accepted = SYSTEM_ALIASES[q] ?? [q];
  let ok = !system || osList.some((x) => accepted.some((a) => x.toLowerCase().includes(a)));
  if (ok && mainline) {
    const ml = `${f['关联代码主线'] ?? ''} ${f['固件版本'] ?? ''}`.toLowerCase();
    ok = ml.includes(String(mainline).toLowerCase());
  }
  return ok;
}

/* ------------------------------------------------------------------ *
 * 数据文件
 * ------------------------------------------------------------------ */

let cache = { file: null, mtimeMs: 0, board: null };

const BOARD_NAME = `board-${PROJECT_ID}.json`;

/** 依次尝试的数据目录：显式配置 -> 会话工作区 -> 部署默认 -> 进程 cwd */
async function candidateDirs(ctx, exec) {
  const list = [];
  const explicit = process.env.DSH_TBFW_DIR || process.env.DSH_FIRMWARE_DIR;
  if (explicit) list.push(explicit);
  const wd = ctx.get?.('workingDirectory');
  if (wd && exec?.agent) {
    try {
      const dir = await wd.ensure(exec.agent, exec.signal);
      if (dir) list.push(path.join(dir, '.tbfw'));
    } catch {
      /* 继续试下一个 */
    }
  }
  if (wd?.defaultDirectory) list.push(path.join(wd.defaultDirectory, '.tbfw'));
  list.push(path.join(process.cwd(), '.tbfw'));
  return [...new Set(list)];
}

/** 凭据所在目录：优先已有 token.json 的候选目录 */
async function tokenDir(ctx, exec) {
  const dirs = await candidateDirs(ctx, exec);
  return dirs.find((d) => fs.existsSync(path.join(d, 'token.json'))) ?? dirs[0];
}

async function readBoard(ctx, exec) {
  const dirs = await candidateDirs(ctx, exec);
  const dir = dirs.find((d) => fs.existsSync(path.join(d, BOARD_NAME)));
  if (!dir) {
    throw new Error(
      `找不到看板索引 ${BOARD_NAME}。已查找: ${dirs.join(' | ')}。` +
        ' 先运行 firmware_sync，或用环境变量 DSH_TBFW_DIR 指定 .tbfw 所在目录。',
    );
  }
  const file = path.join(dir, BOARD_NAME);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(
      `没有本地索引 ${file}。先运行 tbfw 的同步（python3 tbfw/tb.py sync），或调用 firmware_sync 工具。`,
    );
  }
  if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.board) return cache.board;
  const board = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache = { file, mtimeMs: st.mtimeMs, board };
  return board;
}

/* ------------------------------------------------------------------ *
 * 同步（可选）
 * ------------------------------------------------------------------ */

async function fetchPaged(headers, baseUrl, pick, maxPages = 300) {
  const out = [];
  let token = '';
  for (let i = 0; i < maxPages; i++) {
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}pageSize=200${
      token ? `&pageToken=${encodeURIComponent(token)}` : ''
    }`;
    const r = await fetch(url, { headers });
    if (r.status === 401) throw new Error('Teambition 登录态失效，需要重新抓取 cookie（tbfw/login.sh）');
    if (!r.ok) throw new Error(`${baseUrl} -> ${r.status}`);
    const j = await r.json();
    out.push(...(j.result ?? []));
    if (!j.nextPageToken) break;
    token = j.nextPageToken;
  }
  return out;
}

function normalizeFields(cfs, defs) {
  const fields = {};
  for (const cf of cfs ?? []) {
    const def = defs[cf._customfieldId] ?? {};
    const name = def.name ?? cf._customfieldId;
    let val = cf.value;
    const scalar = (x) => (x && typeof x === 'object' ? (x.title ?? x.name ?? x) : x);
    if (['dropDown', 'multipleChoice', 'lookup'].includes(cf.type)) {
      val = Array.isArray(val) ? val.map(scalar) : scalar(val);
    } else if (Array.isArray(val)) {
      val = val.map(scalar);
      if (val.length === 1) val = val[0];
    }
    val = Array.isArray(val) ? val.filter((x) => x !== '' && x != null) : val;
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    fields[name] = val;
  }
  return fields;
}

async function syncBoard(ctx, exec) {
  const dirs = await candidateDirs(ctx, exec);
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'token.json'))) ?? dirs[0];
  const tokFile = path.join(dir, 'token.json');
  if (!fs.existsSync(tokFile)) {
    throw new Error(`缺少凭据文件 ${tokFile}。已查找: ${dirs.join(' | ')}。先运行 tbfw/login.sh。`);
  }
  const tok = JSON.parse(fs.readFileSync(tokFile, 'utf8'));
  const cookie = (tok.cookies ?? [])
    .filter((c) => String(c.domain ?? '').includes('teambition'))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!cookie) throw new Error(`${tokFile} 里没有 teambition cookie`);

  const headers = { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json' };
  const api = 'https://www.teambition.com/api';

  const defList = await fetchPaged(headers, `${api}/v2/projects/${PROJECT_ID}/customfields`);
  const defs = Object.fromEntries(defList.map((d) => [d._id, d]));
  const tasks = await fetchPaged(headers, `${api}/v2/projects/${PROJECT_ID}/tasks`);

  const items = tasks.map((t) => ({
    id: t._id,
    title: t.content,
    uniqueId: t.uniqueId,
    url: `https://www.teambition.com/task/${t._id}`,
    stage: t.taskflowstatus?.name ?? null,
    updated: t.updated,
    isArchived: t.isArchived,
    fields: normalizeFields(t.customfields, defs),
  }));

  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, BOARD_NAME);
  fs.writeFileSync(
    out,
    JSON.stringify({ projectId: PROJECT_ID, syncedAt: new Date().toISOString(), fetched: items.length, items }),
  );
  cache = { file: null, mtimeMs: 0, board: null };
  return { file: out, tasks: items.length };
}

/* ------------------------------------------------------------------ *
 * 检索
 * ------------------------------------------------------------------ */

async function probe(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return { code: r.status, size: Number(r.headers.get('content-length') ?? 0) };
  } catch {
    return { code: 0, size: 0 };
  }
}

async function search(ctx, exec, args) {
  let board;
  try {
    board = await readBoard(ctx, exec);
  } catch (e) {
    if (/找不到看板索引/.test(e.message)) {
      return { status: 'needs_setup', query: String(args.model ?? ''), hint: '先调用 firmware_sync 生成索引（会自动处理登录）', rows: [] };
    }
    throw e;
  }
  const groups = modelGroups(board);
  const query = String(args.model ?? '').trim();
  const { hit, scored } = resolveModel(query, groups);
  if (!hit) {
    return {
      status: 'needs_confirmation',
      query,
      note: '机型无法唯一确定，请让用户在候选里选一个，不要自行猜测',
      candidates: scored.slice(0, 8).map(([score, g]) => ({
        model: g.name,
        score,
        tasks: g.count,
        aliases: g.aliases,
      })),
      rows: [],
    };
  }

  const variants = modelVariants(hit.name);
  let cands = board.items.filter(
    (t) => hitModel(t, variants) && hitSystem(t, args.system, args.mainline),
  );
  // 客户维度：未指定时默认 CP，但必须把「其他客户还有什么」讲出来
  const customerPool = new Map();
  for (const t of cands) {
    for (const c of asList(t.fields?.['客户ID'])) {
      const key = String(c);
      customerPool.set(key, (customerPool.get(key) ?? 0) + 1);
    }
  }
  const requested = String(args.customer ?? '').trim();
  const customerDefaulted = !requested;
  const effective = customerDefaulted ? 'CP' : requested;
  const unlimited = /^(all|\*|不限)$/i.test(effective);
  if (!unlimited) {
    cands = cands.filter((t) =>
      String(t.fields?.['客户ID'] ?? '').toUpperCase().includes(effective.toUpperCase()),
    );
  }
  const others = [...customerPool.entries()]
    .filter(([c]) => !unlimited && !c.toUpperCase().includes(effective.toUpperCase()))
    .sort((a, b) => b[1] - a[1]);
  const othersText = others.slice(0, 6).map(([c, n]) => `${c}(${n})`).join('、');
  if (args.version) {
    const v = String(args.version).toLowerCase();
    cands = cands.filter((t) => String(t.fields?.['固件版本'] ?? '').toLowerCase().includes(v));
  }
  if (args.stage) cands = cands.filter((t) => String(t.stage ?? '').includes(String(args.stage)));
  if (!args.all) cands = cands.filter((t) => Object.keys(linksOf(t)).length > 0);

  cands.sort((a, b) => {
    const [pa, ta] = rankKey(a);
    const [pb, tb] = rankKey(b);
    return pa - pb || ta - tb;
  });

  const seen = new Set();
  const uniq = [];
  for (const t of cands) {
    const key = String(t.fields?.['固件版本'] ?? t.id);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }

  // 归档之外还有更新的在制版本时要点出来，否则「最新」会被误读成已归档的最新
  const bestArchived = Math.max(
    0,
    ...cands.filter((t) => rankKey(t)[0] === 0).map((t) => Number(versionDate(t) || 0)),
  );
  const pendingSeen = new Set();
  const pending = [];
  for (const t of cands) {
    if (rankKey(t)[0] === 0) continue;
    const bd = versionDate(t);
    if (!bd || Number(bd) <= bestArchived) continue;
    const ver = String(t.fields?.['固件版本'] ?? '') || t.title;
    if (pendingSeen.has(ver)) continue;
    pendingSeen.add(ver);
    pending.push({ version: ver, buildDate: bd, stage: t.stage ?? '', task: t.url });
    if (pending.length >= 3) break;
  }

  const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20);
  const picked = uniq.slice(0, limit);

  const rows = picked.map((t) => {
    const links = linksOf(t);
    return {
      version: String(t.fields?.['固件版本'] ?? '') || t.title,
      buildDate: versionDate(t),
      models: asList(t.fields?.['机型']).join(', '),
      system: asList(t.fields?.['操作系统']).join(', '),
      customer: asList(t.fields?.['客户ID']).join(', '),
      language: asList(t.fields?.['固件语言']).join(', '),
      stage: t.stage ?? '',
      updated: String(t.updated ?? '').slice(0, 10),
      links,
      task: t.url,
    };
  });

  if (args.verify) {
    await Promise.all(
      rows.flatMap((r) =>
        Object.entries(r.links)
          // next/alist 是内网分享页（10.16.18.x），本机必然超时；其余仓库都校验
          .filter(([, u]) => !/\/\/(next|alist)\.cpinnov\.run/i.test(u))
          .map(async ([k, u]) => {
            r.checks ??= {};
            r.checks[k] = await probe(u);
          }),
      ),
    );
  }

  const result = {
    status: rows.length ? 'ok' : 'empty',
    query,
    resolvedModel: hit.name,
    aliases: hit.aliases,
    customer: unlimited ? '*' : effective,
    customerDefaulted,
    otherCustomers: others.slice(0, 10).map(([c, n]) => ({ customer: c, tasks: n })),
    total: uniq.length,
    pending,
    rows,
  };
  // DSH 对工具返回值做无损 JSON 校验：值为 undefined 的属性会让整次调用
  // INVALID_TOOL_OUTPUT，所以没有提示时直接省略该字段（schema 里 note 是可选的）。
  if (customerDefaulted && !unlimited) {
    result.note =
      uniq.length === 0 && othersText
        ? `客户 CP 下没有匹配；其他客户还有：${othersText}。需要时用 customer 参数切换。`
        : `未指定客户，已默认按 CP 过滤；其他客户还有：${othersText}`;
  }
  return result;
}

/** 工具返回值要过 DSH 的无损 JSON 校验：undefined 属性会被整次拒绝，这里按 JSON 语义丢掉。 */
function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

const fmtSize = (n) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n}B` : `${v.toFixed(1)}${units[i]}`;
};

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function findToolFor(ctx) {
  return {
    name: 'firmware_find',
    description:
      '按机型和操作系统，在 Teambition「【研发部】CI/CD 发版流程」看板的归档字段里定位量产固件，返回固件版本、构建日期、客户、以及 OSS 线刷/OTA 直链。机型支持自由写法（如 apollo 12 pro、SP2-10PRO）。机型存在歧义时返回 status=needs_confirmation 和候选列表，必须先向用户确认再继续。未指定客户时默认按 CP 过滤，并在 note/otherCustomers 里列出其他客户，不要忽略这部分信息。',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: '机型，接受自由写法：APOLLO2-12PRO、apollo 12 pro、SP2-10PRO、spring2 等',
        },
        system: { type: 'string', description: '操作系统：Android、Debian、BuildRoot。省略则不按系统过滤' },
        customer: { type: 'string', description: '客户ID，如 CP、SZ、QX、VR。省略时默认 CP；传 * 表示不限客户。同一机型的不同客户固件不能混刷' },
        version: { type: 'string', description: '版本号片段，如 V1.08' },
        mainline: { type: 'string', description: '关联代码主线片段，如 Android-11' },
        stage: { type: 'string', description: '阶段过滤，如 生产库归档' },
        limit: { type: 'integer', description: '返回条数上限，默认 5，最大 20' },
        verify: { type: 'boolean', description: '是否 HEAD 校验 minio 链接并返回体积' },
        all: { type: 'boolean', description: '包含没有固件链接的任务，默认 false' },
      },
      required: ['model'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'empty', 'needs_confirmation', 'needs_setup'] },
          query: { type: 'string' },
          resolvedModel: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          customer: { type: 'string' },
          customerDefaulted: { type: 'boolean' },
          otherCustomers: {
            type: 'array',
            items: {
              type: 'object',
              properties: { customer: { type: 'string' }, tasks: { type: 'integer' } },
            },
          },
          total: { type: 'integer' },
          pending: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                version: { type: 'string' },
                buildDate: { type: 'string' },
                stage: { type: 'string' },
                task: { type: 'string' },
              },
            },
          },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                score: { type: 'number' },
                tasks: { type: 'integer' },
                aliases: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                version: { type: 'string' },
                buildDate: { type: 'string' },
                models: { type: 'string' },
                system: { type: 'string' },
                customer: { type: 'string' },
                language: { type: 'string' },
                stage: { type: 'string' },
                updated: { type: 'string' },
                links: { type: 'object' },
                checks: { type: 'object' },
                task: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderFind(value) }],
    },
    async execute(args, exec) {
      return jsonSafe(await search(ctx, exec, args ?? {}));
    },
  };
}

function renderFind(v) {
  if (v.status === 'needs_confirmation') {
    const lines = [`机型「${v.query}」无法唯一确定，需要用户确认：`, ''];
    for (const c of v.candidates) {
      const alias = c.aliases?.length ? `  (同族写法: ${c.aliases.join(' / ')})` : '';
      lines.push(`- ${c.model}  [${c.score} 分, ${c.tasks} 个任务]${alias}`);
    }
    lines.push('', '请让用户选定一个后再调用，不要自行猜测。');
    return lines.join('\n');
  }
  if (v.status === 'needs_setup') {
    return `还没有本地索引。${v.hint ?? '先调用 firmware_sync。'}`;
  }
  if (v.status === 'empty') {
    const base = `没有匹配的固件（机型=${v.resolvedModel}）。`;
    return v.note ? `${base}\n· ${v.note}` : `${base}可放宽 system/customer/stage。`;
  }

  const head = `命中 ${v.total} 条，显示 ${v.rows.length} 条（机型=${v.resolvedModel}${
    v.aliases?.length ? `，同族写法 ${v.aliases.join('/')}` : ''
  }）`;
  const lines = [head, ''];
  if (v.note) lines.push(`· ${v.note}`, '');
  if (v.pending?.length) {
    lines.push('注意：存在比已归档版本更新的在制/测试版本，未经生产归档：');
    for (const x of v.pending) lines.push(`  · ${x.version}  (构建 ${x.buildDate}, ${x.stage})`);
    lines.push('');
  }
  v.rows.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.version}`);
    lines.push(
      `    ${r.buildDate || '无构建日期'} | ${r.models} | ${r.system} | 客户 ${r.customer || '-'} | ${r.language} | ${r.stage} | 更新 ${r.updated}`,
    );
    for (const [k, u] of Object.entries(r.links)) {
      const chk = r.checks?.[k];
      const mark = chk ? `  [${chk.code || 'ERR'}${chk.size ? ` ${fmtSize(chk.size)}` : ''}]` : '';
      lines.push(`    ${k}: ${u}${mark}`);
    }
    lines.push(`    任务: ${r.task}`);
    lines.push('');
  });
  return lines.join('\n');
}

function modelsToolFor(ctx) {
  return {
    name: 'firmware_models',
    description:
      '列出 Teambition 发版看板里出现过的所有机型族，含每个族的规范写法和同族别名、任务数。当 firmware_find 无法确定机型，或用户说法与看板不一致时使用。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          families: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                tasks: { type: 'integer' },
                aliases: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_a, v) => [
        {
          type: 'text',
          text: v.families
            .map((f) => `${f.model}  (${f.tasks})${f.aliases.length ? `  = ${f.aliases.join(' / ')}` : ''}`)
            .join('\n'),
        },
      ],
    },
    async execute(_args, exec) {
      const groups = modelGroups(await readBoard(ctx, exec));
      groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return jsonSafe({ families: groups.map((g) => ({ model: g.name, tasks: g.count, aliases: g.aliases })) });
    },
  };
}

function syncToolFor(ctx) {
  return {
    name: 'firmware_sync',
    description:
      '从 Teambition 重新拉取「【研发部】CI/CD 发版流程」看板的全部任务和归档字段，重建本地索引（约 8600 个任务，耗时 40 秒左右）。索引过期或查不到新版本时使用。登录凭据缺失或即将过期时会自动处理：先尝试静默刷新，再弹出浏览器登录；失败时返回 needs_auth 并说明原因。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'needs_auth'] },
          file: { type: 'string' },
          tasks: { type: 'integer' },
          auth: { type: 'string' },
          tokenState: { type: 'string' },
          reason: { type: 'string' },
          loginUrl: { type: 'string' },
          hint: { type: 'string' },
          browser: { type: 'object' },
        },
      },
      render: (_a, v) =>
        v.status === 'needs_auth'
          ? [
              {
                type: 'text',
                text: [
                  `需要登录 Teambition，但自动登录没完成（${v.reason ?? '未知原因'}）。`,
                  v.browser?.path ? `浏览器: ${v.browser.path} (${v.browser.family})` : null,
                  v.loginUrl ? `登录页: ${v.loginUrl}` : null,
                  v.hint ?? null,
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ]
          : [{ type: 'text', text: `已同步 ${v.tasks} 个任务 -> ${v.file}（凭据: ${v.auth ?? 'cached'}）` }],
    },
    async execute(_args, exec) {
      const dir = await tokenDir(ctx, exec);
      const state = checkToken(dir);
      let auth = 'cached';

      if (state.state !== 'valid') {
        if (process.env.TBFW_AUTO_LOGIN === '0') {
          return jsonSafe({
            status: 'needs_auth',
            tokenState: state.state,
            reason: '自动登录已关闭（TBFW_AUTO_LOGIN=0）',
            hint: '把 cookie 粘给 firmware_login(cookie="...")',
          });
        }
        const login = await ensureToken(dir, {
          mode: process.env.TBFW_HEADLESS === '1' ? 'headless' : 'auto',
        });
        if (login.status !== 'ok') {
          return jsonSafe({
            status: 'needs_auth',
            tokenState: state.state,
            reason: login.reason ?? login.status,
            loginUrl: login.loginUrl,
            browser: login.browser,
            hint: login.hint,
          });
        }
        auth = login.via === 'silent' ? 'silent' : 'window';
      }

      try {
        return jsonSafe({ status: 'ok', ...(await syncBoard(ctx, exec)), auth, tokenState: state.state });
      } catch (e) {
        if (!/登录态失效|401/.test(String(e.message))) throw e;
        const login = await ensureToken(dir, { mode: 'auto' });
        if (login.status !== 'ok') {
          return jsonSafe({
            status: 'needs_auth',
            tokenState: 'rejected',
            reason: login.reason ?? login.status,
            loginUrl: login.loginUrl,
            browser: login.browser,
            hint: login.hint,
          });
        }
        const res = await syncBoard(ctx, exec);
        return jsonSafe({ status: 'ok', ...res, auth: login.via ?? 'window', tokenState: 'rejected' });
      }
    },
  };
}

function loginToolFor(ctx) {
  return {
    name: 'firmware_login',
    description:
      '获取或刷新 Teambition 登录凭据。默认自动：先用持久化的浏览器 profile 静默换发 token（用户无感），失败则弹出浏览器窗口让用户登录。也可以直接粘贴 cookie 或 DevTools 的「Copy as cURL」整段。凭据缺失、过期，或 firmware_sync 返回 needs_auth 时调用。',
    parameters: {
      type: 'object',
      properties: {
        cookie: {
          type: 'string',
          description: '可选。粘贴完整 Cookie 串、单个 TB_ACCESS_TOKEN，或 DevTools 里 Network → 右键「Copy as cURL」的整段命令',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'headless', 'window'],
          description: 'auto=先静默刷新再弹窗（默认）；headless=只试静默刷新；window=直接弹窗',
        },
        timeoutSeconds: { type: 'integer', description: '等待用户完成登录的秒数，默认 180' },
        browser: { type: 'string', description: '可选，指定浏览器路径或命令名（默认用系统默认的 Chromium 系浏览器）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'manual', 'no_display', 'no_browser', 'timeout', 'invalid_cookie'] },
          via: { type: 'string' },
          tokenPath: { type: 'string' },
          expiresAt: { type: 'string' },
          reason: { type: 'string' },
          hint: { type: 'string' },
          loginUrl: { type: 'string' },
          opened: { type: 'boolean' },
          browserLaunched: { type: 'boolean' },
          browser: { type: 'object' },
        },
      },
      render: (_a, v) => [
        {
          type: 'text',
          text:
            v.status === 'ok'
              ? `凭据就绪（${v.via ?? 'unknown'}），有效期至 ${v.expiresAt ?? '?'}`
              : [
                  `需要你手动完成登录（${v.status}）${v.reason ? '：' + v.reason : ''}`,
                  v.browser?.path ? `检测到的浏览器: ${v.browser.path} (${v.browser.family})` : null,
                  v.loginUrl ? `登录页: ${v.loginUrl}${v.opened ? '（已尝试打开）' : ''}` : null,
                  v.hint ?? null,
                ]
                  .filter(Boolean)
                  .join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const dir = await tokenDir(ctx, exec);
      const options = args ?? {};
      if (options.cookie) return jsonSafe(loginWithCookie(dir, options.cookie));
      if (process.env.TBFW_NO_DISPLAY === '1') {
        return jsonSafe({ status: 'no_display', reason: '测试钩子 TBFW_NO_DISPLAY=1', hint: '把 cookie 粘给 firmware_login(cookie="...")' });
      }
      return jsonSafe(await ensureToken(dir, {
        mode: options.mode ?? 'auto',
        timeoutSeconds: options.timeoutSeconds ?? 180,
        browser: options.browser,
      }));
    },
  };
}


export const name = 'firmware-finder';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(findToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(modelsToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(syncToolFor(ctx)));
  ctx.effect(() => ctx.tools.register(loginToolFor(ctx)));
}
