// 从已启动的 Edge(CDP) 中抓取 Teambition 登录 token
// 用法: node capture_token.mjs [--timeout 秒] [--out 路径]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const TIMEOUT = Number(getArg('timeout', 600)) * 1000;
const OUT = getArg('out', path.join(process.cwd(), '.tbfw', 'token.json'));
const CDP = getArg('cdp', 'http://127.0.0.1:9222');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpCall(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const t0 = Date.now();
  let ws = null;

  while (Date.now() - t0 < TIMEOUT) {
    try {
      const r = await fetch(`${CDP}/json/version`);
      const { webSocketDebuggerUrl } = await r.json();
      ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', rej, { once: true });
      });
      break;
    } catch {
      await sleep(1500);
    }
  }
  if (!ws) throw new Error('连不上 CDP，Edge 是否还在运行？');

  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (page) console.error(`当前页面: ${page.url}`);

  while (Date.now() - t0 < TIMEOUT) {
    const { cookies } = await cdpCall(ws, 'Storage.getCookies');
    const wanted = ['TB_ACCESS_TOKEN', '_tb_token_'];
    const tok = wanted
      .map((n) => cookies.find((c) => c.name === n && /(^|\.)teambition\.com$/.test(c.domain)))
      .find((c) => c && c.value && c.value.length > 20);
    if (tok && tok.value && tok.value.length > 20) {
      const payload = {
        token: tok.value,
        domain: tok.domain,
        expires: tok.expires,
        capturedAt: new Date().toISOString(),
        cookies: cookies
          .filter((c) => /(^|\.)teambition\.com$/.test(c.domain))
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain })),
      };
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ ok: true, tokenPrefix: tok.value.slice(0, 12) + '...', out: OUT }));
      ws.close();
      return;
    }
    await sleep(2000);
  }
  throw new Error('等待登录超时，未捕获到 _tb_token_');
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
