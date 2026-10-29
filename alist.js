/**
 * alist 公共只读客户端（仅当 /firmware 检索在 Teambition 里取不到结果时兜底）。
 *
 * 为什么不用全局 fetch：DSH 里 `NODE_USE_ENV_PROXY=1` + `https_proxy=127.0.0.1:7897`，
 * 内网 alist 走本机代理会 TLS 直接断开（实测 error:0A000126）；这里用 `node:https`
 * 直连，绕开代理，与 `curl --noproxy '*'` 行为一致。
 *
 * 接口（guest 只读）：
 *   POST /api/fs/list {path, page, per_page, refresh:false} -> {content:[{name,size,is_dir,modified}], total}
 *   POST /api/fs/get  {path}                                -> {name,size,modified,sign,raw_url,related}
 *
 * `raw_url` 带 sign，可以直接 206 分段下载；不带 sign 的 `/p/Public/...` 会返回 JSON 错误。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export const DEFAULT_BASE = 'https://alist.cpinnov.run';

/** 默认传输层：node:https POST JSON。失败/超时返回 null（调用方静默降级）。 */
function httpsPost({ url, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return done(null);
    }
    const payload = JSON.stringify(body ?? {});
    let req;
    try {
      req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'user-agent': 'firmware-finder/0.4.0',
          },
          timeout: timeoutMs,
          // 必须绕开全局 Agent：DSH 进程里 https.globalAgent 被代理接管
          // （NODE_USE_ENV_PROXY=1），走它会让内网 alist 在 TLS 阶段被 reset。
          agent: false,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            done({ status: res.statusCode ?? 0, json });
          });
          res.on('error', () => done(null));
        },
      );
    } catch {
      return done(null);
    }
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.write(payload);
    req.end();
  });
}

/** 默认传输层：node:https GET 纯文本（只用于 sha256sum.txt 这类小文件）。 */
function httpsGetText({ url, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return done('');
    }
    let req;
    try {
      req = https.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: { 'user-agent': 'firmware-finder/0.4.0' },
          timeout: timeoutMs,
          agent: false,
        },
        (res) => {
          if ((res.statusCode ?? 0) !== 200) {
            res.resume();
            return done('');
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
          res.on('error', () => done(''));
        },
      );
    } catch {
      return done('');
    }
    req.on('timeout', () => {
      req.destroy();
      done('');
    });
    req.on('error', () => done(''));
    req.end();
  });
}

const asSize = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 把 fs/list 与 fs/get 的返回统一成同一种条目形状。 */
export function normalizeEntry(raw, dirPath = '') {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '');
  if (!name) return null;
  return {
    name,
    path: dirPath ? `${dirPath.replace(/\/+$/, '')}/${name}` : String(raw.path ?? ''),
    isDir: raw.is_dir === true || raw.isDir === true,
    size: asSize(raw.size),
    modified: String(raw.modified ?? ''),
    rawUrl: String(raw.raw_url ?? ''),
    sign: String(raw.sign ?? ''),
    related: Array.isArray(raw.related) ? raw.related : [],
  };
}

/**
 * 版本目录名 -> 结构化字段。
 * 例：CP_APOLLO2_D_V1.12_LCD7_B1_CN_20260805
 *     SmartAG_APOLLO2-7A_D_V1.01_LCD7_B1_4G_CN_20240402
 */
export function parseVersionDir(name) {
  const parts = String(name ?? '')
    .split('_')
    .map((x) => x.trim())
    .filter(Boolean);
  const out = {
    raw: String(name ?? ''),
    customer: '',
    product: '',
    osLetter: '',
    version: '',
    lcd: '',
    board: '',
    region: '',
    cellular: '',
    date: '',
    extra: [],
  };
  const leftovers = [];
  for (const part of parts) {
    if (!out.version && /^v\d+(?:\.\d+)*$/i.test(part)) {
      out.version = part.toUpperCase();
      continue;
    }
    if (!out.lcd && /^lcd\d+(?:-\d+)?$/i.test(part)) {
      out.lcd = part.toUpperCase();
      continue;
    }
    if (!out.board && /^b\d+$/i.test(part)) {
      out.board = part.toUpperCase();
      continue;
    }
    if (!out.date && /^20\d{6}$/.test(part)) {
      out.date = part;
      continue;
    }
    if (!out.cellular && /^\d?g$/i.test(part)) {
      out.cellular = part.toUpperCase();
      continue;
    }
    if (!out.region && /^(cn|eu|en|us|na|jp|kr|ru|au|global)$/i.test(part)) {
      out.region = part.toUpperCase();
      continue;
    }
    leftovers.push(part);
  }
  if (!out.version) return null;
  out.customer = leftovers[0] ?? '';
  out.product = leftovers[1] ?? '';
  out.osLetter = leftovers[2] ?? '';
  out.extra = leftovers.slice(3);
  return out;
}

const OS_BY_LETTER = { A: 'Android', D: 'Debian', R: 'BuildRoot', L: 'Linux' };

/** 版本目录里的系统首字母 -> 看板里的系统写法 */
export const osNameByLetter = (letter) => OS_BY_LETTER[String(letter ?? '').toUpperCase()] ?? '';

/**
 * 创建 alist 客户端。所有方法失败都返回 null / 空值，绝不抛错：
 * alist 只是兜底数据源，不能影响 Teambition 主路径。
 *
 * @param {object} options
 * @param {string} [options.base]       站点地址（默认 DSH_ALIST_BASE 或官方地址）
 * @param {string} [options.cacheFile]  缓存文件路径（默认不落盘）
 * @param {number} [options.ttlMs]      缓存 TTL，默认 24h（DSH_ALIST_TTL_MS）
 * @param {number} [options.timeoutMs]  单次请求超时，默认 8s
 * @param {Function} [options.transport] 测试注入：({url, body, timeoutMs}) => Promise<{status, json}|null>
 * @param {Function} [options.getText]   测试注入：({url, timeoutMs}) => Promise<string>
 */
export function createAlist(options = {}) {
  const base = String(options.base || process.env.DSH_ALIST_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const ttlMs = Number(options.ttlMs ?? process.env.DSH_ALIST_TTL_MS ?? 24 * 3600 * 1000);
  const timeoutMs = Number(options.timeoutMs ?? 8000);
  const transport = options.transport || httpsPost;
  const getText = options.getText || httpsGetText;
  const cacheFile = options.cacheFile || '';
  const stats = { requests: 0, cacheHits: 0, failures: 0 };

  let cache = null;
  const loadCache = () => {
    if (cache) return cache;
    cache = { version: 1, entries: {} };
    if (!cacheFile) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (raw && typeof raw.entries === 'object') cache = { version: 1, entries: raw.entries };
    } catch {
      /* 缓存损坏就当没有 */
    }
    return cache;
  };
  const saveCache = () => {
    if (!cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, cacheFile);
    } catch {
      /* 缓存写失败不影响查询 */
    }
  };
  const fresh = (entry) => entry && Date.now() - Number(entry.at || 0) < ttlMs;
  const readCache = (key) => {
    const entry = loadCache().entries[key];
    if (fresh(entry)) {
      stats.cacheHits += 1;
      return entry.data;
    }
    return undefined;
  };
  const writeCache = (key, data) => {
    loadCache().entries[key] = { at: Date.now(), data };
    saveCache();
  };

  async function post(apiPath, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stats.requests += 1;
      const response = await transport({ url: `${base}${apiPath}`, body, timeoutMs });
      if (response && response.status === 200 && response.json) {
        if (response.json.code === 200) return response.json.data;
        if (response.json.code !== 200) return null;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stats.failures += 1;
    return null;
  }

  /** 列目录（自动翻页），失败返回 null。 */
  async function list(dirPath) {
    const key = `list:${dirPath}`;
    const hit = readCache(key);
    if (hit !== undefined) return hit;
    const out = [];
    for (let page = 1; page <= 10; page += 1) {
      const data = await post('/api/fs/list', { path: dirPath, page, per_page: 200, refresh: false });
      if (!data) return null;
      const items = Array.isArray(data.content) ? data.content : [];
      for (const item of items) {
        const entry = normalizeEntry(item, dirPath);
        if (entry) out.push(entry);
      }
      const total = Number(data.total ?? 0);
      if (items.length === 0 || out.length >= total) break;
    }
    writeCache(key, out);
    return out;
  }

  /** 取单条元数据（含 sign/raw_url），失败返回 null。 */
  async function entry(filePath) {
    const key = `entry:${filePath}`;
    const hit = readCache(key);
    if (hit !== undefined) return hit;
    const data = await post('/api/fs/get', { path: filePath });
    if (!data) return null;
    const normalized = normalizeEntry(data, filePath.replace(/\/[^/]+$/, ''));
    writeCache(key, normalized);
    return normalized;
  }

  /** 小文件正文（sha256sum.txt 等），失败返回 ''。 */
  async function text(filePath) {
    const key = `text:${filePath}`;
    const hit = readCache(key);
    if (hit !== undefined) return hit;
    const meta = await entry(filePath);
    if (!meta || !meta.rawUrl) return '';
    stats.requests += 1;
    const body = await getText({ url: meta.rawUrl, timeoutMs });
    if (!body) {
      stats.failures += 1;
      return '';
    }
    writeCache(key, body);
    return body;
  }

  /** 文件在浏览器里的页面地址（无需 sign）。 */
  const pageUrl = (filePath) => `${base}${filePath.startsWith('/') ? '' : '/'}${filePath}`;

  return {
    base,
    list,
    entry,
    text,
    pageUrl,
    stats,
    get failures() {
      return stats.failures;
    },
  };
}
