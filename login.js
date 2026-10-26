// Teambition 登录凭据管理：检测 / 静默刷新 / 弹窗登录 / 手动 cookie 兜底
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

const LOGIN_URL = 'https://www.teambition.com/task/6aa37acf26bc249d957f5798';
const API_PROBE = 'https://www.teambition.com/api/users/me';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANUAL_HINT =
  '手动获取：在该浏览器打开 Teambition 并登录 → F12 → Network → 任意请求右键「Copy as cURL」→ ' +
  '把整段粘给 firmware_login(cookie="...")。TB_ACCESS_TOKEN 是 HttpOnly，document.cookie 读不到。';

export const tokenFile = (dataDir) => path.join(dataDir, 'token.json');
export const profileDir = (dataDir) => path.join(dataDir, 'browser-profile');

/** JWT 的 exp（毫秒）；解不开返回 0 */
export function jwtExpiry(token) {
  try {
    const payload = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** 凭据状态：missing / invalid / expired / expiring / valid */
export function checkToken(dataDir, { skewMs = 5 * 60 * 1000 } = {}) {
  const file = tokenFile(dataDir);
  if (!fs.existsSync(file)) return { state: 'missing', file };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { state: 'invalid', file, reason: 'token.json 不是合法 JSON' };
  }
  const token = data?.token;
  if (!token) return { state: 'invalid', file, reason: '缺少 token 字段' };
  const exp = jwtExpiry(token);
  if (!exp) return { state: 'invalid', file, reason: 'token 不是可解析的 JWT' };
  const left = exp - Date.now();
  if (left <= 0) return { state: 'expired', file, exp, minutesLeft: Math.floor(left / 60000) };
  if (left < skewMs) return { state: 'expiring', file, exp, minutesLeft: Math.max(1, Math.round(left / 60000)) };
  return { state: 'valid', file, exp, minutesLeft: Math.round(left / 60000) };
}

/**
 * 宿主进程往往没有 DISPLAY/WAYLAND_DISPLAY（例如从服务启动），
 * 但同用户的 Wayland 套接字存在，显式补上即可。
 */
export function resolveDisplayEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    return { ok: true, env, mode: env.WAYLAND_DISPLAY ? 'wayland' : 'x11' };
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (fs.existsSync(path.join(runtime, 'wayland-0'))) {
    env.XDG_RUNTIME_DIR = runtime;
    env.WAYLAND_DISPLAY = 'wayland-0';
    return { ok: true, env, mode: 'wayland' };
  }
  for (const sock of ['/tmp/.X11-unix/X0', '/tmp/.X11-unix/X1']) {
    if (fs.existsSync(sock)) return { ok: true, env: { ...env, DISPLAY: `:${sock.slice(-1)}` }, mode: 'x11' };
  }
  return { ok: false, env, mode: 'none' };
}

const CHROMIUM_RE = /chrom|edge|brave|vivaldi|opera/i;
const BROWSER_NAME_RE =
  /^(microsoft-edge|google-chrome|chromium-browser|chromium|chrome|brave-browser|brave|vivaldi|opera|firefox)([-.].*)?$/i;

function homeDir() {
  return process.env.HOME || `/home/${typeof process.getuid === 'function' ? process.getuid() : ''}`;
}

/** .desktop 可能出现在标准目录、flatpak 导出目录或 snap 的 desktop 目录 */
function desktopDirs() {
  const home = homeDir();
  return [
    '/usr/share/applications',
    '/usr/local/share/applications',
    `${home}/.local/share/applications`,
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ];
}

function xdgDefaultDesktop() {
  const probes = [
    ['xdg-settings', ['get', 'default-web-browser']],
    ['xdg-mime', ['query', 'default', 'x-scheme-handler/https']],
  ];
  for (const [cmd, args] of probes) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000 }).trim();
      if (out) return out;
    } catch {
      /* 没有 xdg-utils 或返回空，继续试下一个 */
    }
  }
  return null;
}

/** 解析 .desktop 的 Exec，剥掉 %U/%F 之类的占位符，保留 flatpak/snap 前缀 */
function desktopCommand(desktopId) {
  for (const dir of desktopDirs()) {
    const file = path.join(dir, desktopId);
    if (!fs.existsSync(file)) continue;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = text.match(/^Exec=(.+)$/m);
    if (!m) continue;
    const argv = m[1]
      .trim()
      .replace(/%[UFfudDnNickvm]/g, '')
      .split(/\s+/)
      .filter(Boolean);
    if (argv.length) return { argv, source: 'desktop-entry' };
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 候选目录：PATH、snap、flatpak 导出、用户本地 bin */
function scanDirs() {
  const dirs = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  dirs.add('/snap/bin');
  dirs.add('/var/lib/flatpak/exports/bin');
  dirs.add(`${homeDir()}/.local/bin`);
  return [...dirs];
}

/** 用 --version 判断二进制是否真是 Chromium 系（能跑 CDP） */
function probeFamily(bin) {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return CHROMIUM_RE.test(out) ? 'chromium' : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * 分层发现浏览器：
 *   L0 显式指定 -> L1 系统默认浏览器(.desktop) -> L2 PATH/snap/flatpak 扫描 -> L3 能力探测
 * 返回 { cmd, path, family, source }；cmd 用于 spawn（保留 flatpak/snap 前缀）。
 */
export function discoverBrowsers(explicit = process.env.TBFW_BROWSER) {
  const found = [];
  const push = (argv, source) => {
    if (!argv?.length) return;
    let real = argv;
    if (argv.length === 1) {
      try {
        real = [fs.realpathSync(argv[0])];
      } catch {
        real = argv;
      }
    }
    const key = real.join('\u0000');
    if (found.some((b) => b.realKey === key)) return;
    const bin = argv[0];
    const direct = argv.length === 1 && isExecutable(bin);
    const family = direct ? probeFamily(bin) : CHROMIUM_RE.test(argv.join(' ')) ? 'chromium' : 'other';
    found.push({ cmd: real, path: real[0], family, source, realKey: key });
  };

  // L0 显式
  if (explicit) {
    if (explicit.includes('/')) {
      if (isExecutable(explicit)) push([explicit], 'explicit');
    } else {
      for (const dir of scanDirs()) {
        const p = path.join(dir, explicit);
        if (isExecutable(p)) {
          push([p], 'explicit');
          break;
        }
      }
    }
    return found; // 显式指定即唯一候选：不可用就报错，不要偷偷换成别的浏览器
  }

  // L1 系统默认浏览器
  const desktopId = xdgDefaultDesktop();
  if (desktopId) {
    const cmd = desktopCommand(desktopId);
    if (cmd) push(cmd.argv, `${cmd.source}:${desktopId}`);
  }

  // L2 + L3 扫描
  for (const dir of scanDirs()) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!BROWSER_NAME_RE.test(name)) continue;
      const p = path.join(dir, name);
      if (isExecutable(p)) push([p], 'scan');
    }
  }
  return found;
}

/** 兼容旧调用：返回第一个可驱动（Chromium 系）的浏览器 */
export function resolveBrowser(explicit = process.env.TBFW_BROWSER) {
  const list = discoverBrowsers(explicit);
  return list.find((b) => b.family === 'chromium') ?? null;
}

/** 用系统默认方式打开链接（非 Chromium 浏览器走这条） */
export function openExternal(url) {
  const candidates = [['xdg-open', [url]], ['gio', ['open', url]], ['open', [url]]];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      /* 试下一个 */
    }
  }
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function launchBrowser({ browser, env, port, userData, headless }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userData}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--disable-crash-reporter',
  ];
  if (headless) args.unshift('--headless=new');
  if (env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland');
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push(LOGIN_URL);

  const [bin, ...prefix] = browser.cmd;
  const child = spawn(bin, [...prefix, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(-2000);
  });
  child.on('error', () => {});
  return { child, getStderr: () => stderr };
}

function killBrowser(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, 1500).unref?.();
  } catch {
    /* 已退出 */
  }
}

async function cdpVersion(port, timeoutMs = 1000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** 连上浏览器级 CDP，读一次全部 cookie */
async function readCookies(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error('CDP 超时')), 5000);
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method: 'Storage.getCookies', params: {} }));
    });
    return result.cookies ?? [];
  } finally {
    ws.close();
  }
}

const isTeambition = (c) => /(^|\.)teambition\.com$/.test(c.domain || '');

function payloadFrom(cookies) {
  const tok = cookies.find((c) => c.name === 'TB_ACCESS_TOKEN' && (c.value || '').length > 20);
  if (!tok) return null;
  return {
    token: tok.value,
    domain: tok.domain,
    expires: tok.expires,
    capturedAt: new Date().toISOString(),
    cookies: cookies.filter(isTeambition).map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
  };
}

function writeToken(dataDir, payload) {
  const file = tokenFile(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

/** 启动一次浏览器并轮询 token；成功返回 payload，超时返回 null */
async function captureViaBrowser({ dataDir, display, browser, headless, timeoutMs }) {
  const port = await freePort();
  const userData = profileDir(dataDir);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });

  const { child, getStderr } = launchBrowser({ browser, env: display.env, port, userData, headless });
  const deadline = Date.now() + timeoutMs;
  try {
    let version = null;
    while (Date.now() < deadline && !version) {
      if (child.exitCode !== null) {
        return { payload: null, error: `浏览器提前退出（code ${child.exitCode}）${getStderr() ? ': ' + getStderr().slice(-300) : ''}` };
      }
      version = await cdpVersion(port);
      if (!version) await sleep(400);
    }
    if (!version) return { payload: null, error: '浏览器未在超时内开放调试端口' };

    while (Date.now() < deadline) {
      if (child.exitCode !== null) return { payload: null, error: '浏览器已关闭（未完成登录）' };
      try {
        const cookies = await readCookies(version.webSocketDebuggerUrl);
        const payload = payloadFrom(cookies);
        if (payload && jwtExpiry(payload.token) > Date.now()) return { payload, error: null };
      } catch {
        /* CDP 偶发失败，继续轮询 */
      }
      await sleep(1200);
    }
    return { payload: null, error: '等待登录超时' };
  } finally {
    killBrowser(child);
  }
}

/** 从 DevTools「Copy as cURL」里抽出 cookie，HttpOnly 场景下最省事的复制方式 */
export function cookieFromCurl(text) {
  const normalized = String(text).replace(/\\\r?\n/g, ' ');
  if (!/\bcurl\b/i.test(normalized)) return null;
  const patterns = [
    /-H\s+(['"])cookie:\s*([\s\S]*?)\1/i,
    /--header\s+(['"])cookie:\s*([\s\S]*?)\1/i,
    /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i,
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m && m[2]?.trim()) return m[2].trim();
  }
  return null;
}

/** 从 cookie 串写入凭据（name=value; name=value、单个 JWT、或 Copy as cURL） */
export async function loginWithCookie(dataDir, cookieText) {
  let raw = String(cookieText || '').trim();
  if (!raw) return { status: 'invalid_cookie', reason: 'cookie 为空' };
  if (/\bcurl\b/i.test(raw)) {
    const extracted = cookieFromCurl(raw);
    if (!extracted) return { status: 'invalid_cookie', reason: '这段 curl 里没有找到 cookie 头' };
    raw = extracted;
  }

  let cookies;
  if (raw.split('.').length === 3) {
    cookies = [{ name: 'TB_ACCESS_TOKEN', value: raw, domain: '.teambition.com' }];
  } else {
    cookies = raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf('=');
        return i > 0 ? { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '.teambition.com' } : null;
      })
      .filter(Boolean);
  }
  const payload = payloadFrom(cookies);
  if (!payload) return { status: 'invalid_cookie', reason: '没有找到 TB_ACCESS_TOKEN' };
  if (jwtExpiry(payload.token) <= Date.now()) return { status: 'invalid_cookie', reason: 'TB_ACCESS_TOKEN 已过期' };

  const header = payload.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  try {
    const r = await fetch(API_PROBE, { headers: { Cookie: header, 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (r.status !== 200) return { status: 'invalid_cookie', reason: `服务端拒绝（HTTP ${r.status}）` };
  } catch (e) {
    return { status: 'invalid_cookie', reason: `校验请求失败: ${e.message}` };
  }

  const file = writeToken(dataDir, payload);
  return { status: 'ok', tokenPath: file, expiresAt: new Date(jwtExpiry(payload.token)).toISOString() };
}

let inflight = null;

/**
 * 确保有可用 token：静默刷新 → 弹窗 → 降级。
 * 并发调用共享同一次登录。
 */
export function ensureToken(dataDir, options = {}) {
  if (inflight) return inflight;
  inflight = runEnsure(dataDir, options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runEnsure(dataDir, options) {
  const mode = options.mode || 'auto'; // auto | headless | window
  const timeoutMs = (options.timeoutSeconds ?? 180) * 1000;

  const browsers = discoverBrowsers(options.browser);
  const chromium = browsers.find((b) => b.family === 'chromium');
  const display = resolveDisplayEnv();

  // 没有 Chromium 系：不驱动别的浏览器，直接给手动路径
  if (!chromium) {
    const other = browsers.find((b) => b.family !== 'unknown') ?? null;
    return {
      status: 'manual',
      reason: other
        ? `检测到 ${other.path}（非 Chromium 系），无法通过 CDP 自动读取 HttpOnly cookie`
        : '没有找到可自动驱动的 Chromium 系浏览器',
      browser: other ? { path: other.path, family: other.family, source: other.source } : null,
      loginUrl: LOGIN_URL,
      opened: mode !== 'headless' && openExternal(LOGIN_URL),
      hint: MANUAL_HINT,
    };
  }

  const browserInfo = { path: chromium.path, family: chromium.family, source: chromium.source };

  if (!display.ok && mode !== 'headless') {
    return {
      status: 'no_display',
      reason: '宿主进程没有图形环境（无 DISPLAY/WAYLAND_DISPLAY，也没有可用的 Wayland 套接字）',
      browser: browserInfo,
      loginUrl: LOGIN_URL,
      opened: openExternal(LOGIN_URL),
      hint: MANUAL_HINT,
    };
  }

  // 1) 静默刷新：用持久化 profile 让 SPA 换发新 token，用户无感
  if (mode === 'auto' || mode === 'headless') {
    const silent = await captureViaBrowser({
      dataDir,
      display,
      browser: chromium,
      headless: true,
      timeoutMs: Math.min(25000, timeoutMs),
    });
    if (silent.payload) {
      const file = writeToken(dataDir, silent.payload);
      return {
        status: 'ok',
        via: 'silent',
        tokenPath: file,
        expiresAt: new Date(jwtExpiry(silent.payload.token)).toISOString(),
        browserLaunched: false,
        browser: browserInfo,
      };
    }
    if (mode === 'headless') {
      return { status: 'timeout', via: 'silent', reason: silent.error, browser: browserInfo, hint: MANUAL_HINT };
    }
  }

  // 2) 弹窗登录
  const visible = await captureViaBrowser({ dataDir, display, browser: chromium, headless: false, timeoutMs });
  if (visible.payload) {
    const file = writeToken(dataDir, visible.payload);
    return {
      status: 'ok',
      via: 'window',
      tokenPath: file,
      expiresAt: new Date(jwtExpiry(visible.payload.token)).toISOString(),
      browserLaunched: true,
      browser: browserInfo,
    };
  }
  return {
    status: 'timeout',
    via: 'window',
    reason: visible.error,
    loginUrl: LOGIN_URL,
    browser: browserInfo,
    hint: MANUAL_HINT,
  };
}
