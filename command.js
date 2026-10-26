/**
 * `/cpfirmware` 斜杠命令。
 *
 * 设计约束：
 * - 解析是纯函数（`parseCommandInput`），可离线单测；执行时通过 `deps` 注入
 *   index.js 里的检索实现，避免两个模块互相 import 形成循环依赖。
 * - 走宿主侧命令平面（`ctx.commands`），不产生模型消息、不花 token；
 *   结果文本由 Web 客户端渲染成可展开的纯文本卡片。
 * - `command/run` 不记录原始输入（recordInput: false）：
 *   一是输入里可能夹带粘贴的 cookie，二是结果本身已经包含解析后的查询。
 */

const COMMAND = 'cpfirmware';

/** 首词即子命令；`find` 是机型恰好叫 sync/model 之类时的逃生口 */
const SUBCOMMANDS = new Map([
  ['sync', 'sync'],
  ['同步', 'sync'],
  ['刷新', 'sync'],
  ['更新', 'sync'],
  ['status', 'status'],
  ['状态', 'status'],
  ['models', 'models'],
  ['model', 'models'],
  ['机型', 'models'],
  ['机型列表', 'models'],
  ['模型列表', 'models'],
  ['login', 'login'],
  ['登录', 'login'],
  ['help', 'help'],
  ['帮助', 'help'],
  ['用法', 'help'],
  ['?', 'help'],
  ['find', 'find'],
  ['查询', 'find'],
]);

const VALUE_FLAGS = new Map([
  ['-c', 'customer'],
  ['--customer', 'customer'],
  ['--客户', 'customer'],
  ['-s', 'system'],
  ['--system', 'system'],
  ['--系统', 'system'],
  ['--version', 'version'],
  ['--版本', 'version'],
  ['--mainline', 'mainline'],
  ['--主线', 'mainline'],
  ['--stage', 'stage'],
  ['--阶段', 'stage'],
  ['-n', 'limit'],
  ['--limit', 'limit'],
  ['--数量', 'limit'],
]);

const BOOL_FLAGS = new Map([
  ['--verify', 'verify'],
  ['--all', 'all'],
]);

/** 系统词：长写法优先，命中后从查询里删掉，否则会把机型串坏 */
const SYSTEM_WORDS = [
  ['gnu/linux', 'linux'],
  ['linux 系统', 'linux'],
  ['linux系统', 'linux'],
  ['android 系统', 'android'],
  ['android系统', 'android'],
  ['android', 'android'],
  ['安卓', 'android'],
  ['debian', 'debian'],
  ['buildroot', 'buildroot'],
  ['linux', 'linux'],
];

/**
 * 纯 latin 噪声词：nz() 只剥非字母数字，这些词会粘到机型上导致匹配失败。
 * 实测 `找一下 spring2 的 Android 固件` / `spring2pro 最新的 OTA` 必须靠这一步。
 */
const NOISE =
  /\b(android|debian|buildroot|linux|ota|oss|img|zip|tar|gz|bin|latest|newest|verify|url|link|firmware|fw|download)\b/gi;

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

const toNumber = (s) => (/^\d+$/.test(s) ? Number(s) : (CN_NUM[s] ?? undefined));

/** 删掉所有系统词，返回剩下的查询文本 */
function stripSystem(text) {
  let out = text;
  for (const [word] of SYSTEM_WORDS) {
    if (out.toLowerCase().includes(word)) {
      out = out.replace(new RegExp(word.replace(/[/\\]/g, '\\$&'), 'gi'), ' ');
    }
  }
  return out;
}

function detectSystem(text) {
  const lower = text.toLowerCase();
  for (const [word, system] of SYSTEM_WORDS) {
    if (lower.includes(word)) return system;
  }
  return '';
}

/**
 * 解析 `/cpfirmware …` 的输入。
 *
 * @param {string} raw 命令名之后的原文（含分隔空格）
 * @returns {{kind:'help'}|{kind:'sync'}|{kind:'status'}|{kind:'models'}
 *   |{kind:'login',mode?:string,cookie?:string}
 *   |{kind:'badflag',text:string}
 *   |{kind:'find',query:string,system?:string,customer?:string,version?:string,mainline?:string,stage?:string,limit?:number,verify?:boolean,all?:boolean,notes:string[]}}
 *   纯描述，不含看板数据；`query` 还没经过 resolveModel。
 */
export function parseCommandInput(raw) {
  const input = String(raw ?? '').trim();
  if (input === '') return { kind: 'help' };

  const tokens = input.split(/\s+/).filter(Boolean);
  let sub = null;
  const first = SUBCOMMANDS.get(tokens[0].toLowerCase()) ?? SUBCOMMANDS.get(tokens[0]);
  if (first) {
    sub = first;
    tokens.shift();
  }

  // 子命令先于参数解析：`login` 后面可能粘整段 cookie / Copy as cURL，
  // 里面全是 `-H`、`--compressed` 之类的 token，不能当参数解析。
  const remainder = tokens.join(' ').trim();
  if (sub === 'help') return { kind: 'help' };
  if (sub === 'sync') return { kind: 'sync' };
  if (sub === 'status') return { kind: 'status' };
  if (sub === 'models') return { kind: 'models' };
  if (sub === 'login') {
    const mode = /^(auto|headless|window)$/i.test(remainder) ? remainder.toLowerCase() : undefined;
    if (remainder && !mode) return { kind: 'login', cookie: remainder };
    return { kind: 'login', mode };
  }

  const flags = {};
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const key = VALUE_FLAGS.get(token) ?? VALUE_FLAGS.get(token.toLowerCase());
    if (key) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'badflag', text: `参数 ${token} 缺少取值。` };
      }
      flags[key] = value;
      i++;
      continue;
    }
    const boolKey = BOOL_FLAGS.get(token) ?? BOOL_FLAGS.get(token.toLowerCase());
    if (boolKey) {
      flags[boolKey] = true;
      continue;
    }
    if (token.startsWith('--') || token.startsWith('-')) {
      return { kind: 'badflag', text: `不认识的参数 ${token}。` };
    }
    rest.push(token);
  }

  const text = rest.join(' ').trim();

  const notes = [];

  // 客户：显式 flag > 「所有客户」类的自然语言 > 交给 search 默认 CP
  let customer = flags.customer;
  if (!customer && /不限客户|所有客户|全部客户|all customers/i.test(input)) customer = '*';

  // 系统：显式 flag > 原文里的系统词；随后把系统词从查询里删掉
  const system = flags.system ?? (detectSystem(text) || undefined);

  // 提示词。命中的数量短语要从查询里删掉：nz() 会保留数字，
  // 「最近3个 apollo 12 pro」不清掉 3 就会把查询拼成 3apollo12pro 而匹配失败。
  let body = text;

  let limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && !Number.isFinite(limit)) return { kind: 'badflag', text: `--limit 需要数字。` };
  if (limit === undefined) {
    const heard =
      body.match(/最近\s*(\d+|[一二两三四五六七八九十])\s*[个条]?/i) ??
      body.match(/\btop\s*(\d+)/i) ??
      body.match(/前\s*(\d+)/);
    const n = heard ? toNumber(heard[1]) : undefined;
    if (n) {
      limit = n;
      body = body.replace(heard[0], ' ');
    } else if (/最新|最新版|\blatest\b|\bnewest\b/i.test(body)) {
      limit = 1;
    }
  }

  const verify = flags.verify === true || /校验|\bverify\b|体积|大小/i.test(input);

  let version = flags.version;
  if (!version) {
    const m = body.match(/\bv\d+(?:\.\d+)+\b/i);
    if (m) version = m[0];
  }

  let mainline = flags.mainline;
  if (!mainline) {
    const m = body.match(/\b(?:android|linux|debian|buildroot)-\d+(?:\.\d+)*\b/i);
    if (m) mainline = m[0];
  }

  // query 保留中文：splitVendor 认识「瑞芯微 / 全志」这类厂商写法，
  // 而 nz() 反正会把中文剥掉，所以不会影响机型匹配。
  const query = stripSystem(body)
    .replace(/\bv\d+(?:\.\d+)+\b/gi, ' ')
    .replace(/\b(?:android|linux|debian|buildroot)-\d+(?:\.\d+)*\b/gi, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (flags.all === true) notes.push('包含没有下载链接的任务');

  return {
    kind: 'find',
    query,
    ...(system ? { system } : {}),
    ...(customer ? { customer } : {}),
    ...(version ? { version } : {}),
    ...(mainline ? { mainline } : {}),
    ...(flags.stage ? { stage: flags.stage } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(verify ? { verify: true } : {}),
    ...(flags.all === true ? { all: true } : {}),
    notes,
  };
}

const fmtAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '时间未知';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour} 小时前`;
  return `${Math.round(hour / 24)} 天前`;
};

const fmtExpiry = (exp) => {
  if (!exp) return '到期时间未知';
  const left = exp - Date.now();
  const when = new Date(exp).toLocaleString('zh-CN', { hour12: false });
  if (left <= 0) return `已过期（${when}）`;
  const hour = Math.floor(left / 3600000);
  const min = Math.max(1, Math.round((left % 3600000) / 60000));
  return `${when}（剩余 ${hour > 0 ? `${hour} 小时 ` : ''}${min} 分钟）`;
};

function usageText() {
  return [
    `/${COMMAND} —— 在 Teambition「【研发部】CI/CD 发版流程」归档字段里找量产固件`,
    '',
    '直接说人话就行：',
    `  /${COMMAND} 帮我找 spring2pro 最新的固件`,
    `  /${COMMAND} spring2pro android`,
    `  /${COMMAND} spring2pro -c SZ --verify     # 指定客户 + HEAD 校验链接`,
    `  /${COMMAND} 所有客户 apollo 12 pro         # 不限客户`,
    '',
    '子命令：',
    '  sync     重拉看板索引（约 40 秒，凭据过期会拉起登录）',
    '  status   索引 / 凭据状态',
    '  models   所有机型族与同族写法',
    '  login    刷新登录凭据（自动弹浏览器；也可粘 cookie）',
    '',
    '参数：',
    '  -c, --customer <CP|SZ|QX|VR|*>   默认 CP',
    '  -s, --system   <android|debian|buildroot|linux>',
    '  --version <V1.08>   --mainline <Android-11>   --stage <生产库归档>',
    '  -n, --limit <1-20>                默认 3；说「最新」时 1',
    '  --verify                          HEAD 校验下载链接并显示体积',
    '  校验（等价 --verify）',
  ].join('\n');
}

/** 报错信息里只显示 latin 部分（中文填充词对机型匹配没有意义） */
function displayQuery(query) {
  const latin = String(query ?? '')
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return latin || String(query ?? '').trim();
}

function ambiguousText(parsed, candidates, groups) {
  const lines = [];
  const shown = displayQuery(parsed.query);
  if (!shown) {
    lines.push('没说是什么机型。');
  } else {
    lines.push(`机型「${shown}」无法唯一确定，换个写法再试：`);
  }
  lines.push('');
  const list = candidates.length
    ? candidates
    : groups
        .slice()
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 10)
        .map((g) => ({ model: g.name, tasks: g.count, aliases: g.aliases }));
  for (const c of list) {
    const alias = c.aliases?.length ? `   = ${c.aliases.join(' / ')}` : '';
    lines.push(`  ${c.model}   (${c.tasks} 个任务)${alias}`);
  }
  lines.push('', `用法: /${COMMAND} <机型> [系统] [--customer CP] [--verify]`, `看全部机型: /${COMMAND} models`);
  return lines.join('\n');
}

function helpForMissingIndex() {
  return [
    '还没有本地索引。',
    `运行 /${COMMAND} sync 抓取（约 40 秒；凭据缺失或过期会自动拉起浏览器登录）。`,
  ].join('\n');
}

const TOKEN_LABEL = {
  valid: '有效',
  expiring: '即将过期',
  expired: '已过期',
  missing: '缺失',
  invalid: '不可用',
};

function renderStatus({ dir, board, token, boardError }) {
  // 第一行是折叠态摘要，所以放最有信息量的索引状态
  const lines = [];
  if (board) {
    const age = Date.now() - Date.parse(board.syncedAt ?? '');
    lines.push(`索引:     ${board.items?.length ?? board.fetched ?? '?'} 个任务，同步于 ${fmtAge(age)}`);
    if (age > 3 * 86400000) lines.push(`          ⚠ 索引超过 3 天，建议 /${COMMAND} sync`);
  } else {
    lines.push(`索引:     无（${boardError ?? '未生成'}，运行 /${COMMAND} sync）`);
  }
  const label = TOKEN_LABEL[token.state] ?? token.state;
  if (token.state === 'valid' || token.state === 'expiring') {
    lines.push(`凭据:     ${label}，${fmtExpiry(token.exp)}`);
  } else if (token.state === 'missing') {
    lines.push(`凭据:     ${label}（/${COMMAND} sync 会自动拉起登录）`);
  } else {
    lines.push(`凭据:     ${label}${token.reason ? `（${token.reason}）` : ''}`);
    lines.push(`          /${COMMAND} sync 或 /${COMMAND} login 重新获取`);
  }
  lines.push(`数据目录: ${dir}`);
  lines.push('', `用法: /${COMMAND} <机型> [系统] [--customer CP] [--verify]`, `机型: /${COMMAND} models`);
  return lines.join('\n');
}

function renderModels(groups) {
  const sorted = groups.slice().sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const lines = [`共 ${sorted.length} 个机型族（按任务数排序）：`, ''];
  for (const g of sorted) {
    const alias = g.aliases?.length ? `   = ${g.aliases.join(' / ')}` : '';
    lines.push(`  ${g.name}   (${g.count})${alias}`);
  }
  return lines.join('\n');
}

function renderSync(result, deps) {
  if (result.status === 'needs_auth') {
    return [
      `需要登录 Teambition，但自动登录没完成（${result.reason ?? '未知原因'}）。`,
      result.browser?.path ? `浏览器: ${result.browser.path} (${result.browser.family})` : null,
      result.loginUrl ? `登录页: ${result.loginUrl}` : null,
      result.hint ?? null,
      `也可以 /${COMMAND} login <cookie>` + ' 直接粘贴凭据。',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return `已同步 ${result.tasks} 个任务 -> ${result.file}（凭据: ${result.auth ?? 'cached'}）`;
}

function renderLogin(result) {
  if (result.status === 'ok') return `凭据就绪（${result.via ?? 'unknown'}），有效期至 ${result.expiresAt ?? '?'}`;
  return [
    `需要你手动完成登录（${result.status}）${result.reason ? '：' + result.reason : ''}`,
    result.browser?.path ? `检测到的浏览器: ${result.browser.path} (${result.browser.family})` : null,
    result.loginUrl ? `登录页: ${result.loginUrl}${result.opened ? '（已尝试打开）' : ''}` : null,
    result.hint ?? null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 执行一次 `/cpfirmware`。
 *
 * @param {object} ctx 插件上下文（仅用于取 workingDirectory）
 * @param {object} deps index.js 注入的检索/同步实现
 * @param {{agent:object, rawInput:string, signal:AbortSignal}} inv 命令调用
 * @returns {Promise<{kind:'success'|'error', text:string}>}
 */
export async function runCommand(ctx, deps, inv) {
  const exec = { agent: inv.agent, signal: inv.signal };
  const parsed = parseCommandInput(inv.rawInput);

  switch (parsed.kind) {
    case 'help':
      return { kind: 'success', text: usageText() };
    case 'badflag':
      return { kind: 'error', text: `${parsed.text}\n\n${usageText()}` };
    case 'sync': {
      const result = await deps.syncNow(ctx, exec);
      return { kind: result.status === 'ok' ? 'success' : 'error', text: renderSync(result, deps) };
    }
    case 'status': {
      const dir = await deps.tokenDir(ctx, exec);
      let board = null;
      let boardError = null;
      try {
        board = await deps.readBoard(ctx, exec);
      } catch (e) {
        boardError = '未生成';
      }
      return { kind: 'success', text: renderStatus({ dir, board, token: deps.checkToken(dir), boardError }) };
    }
    case 'models': {
      let board;
      try {
        board = await deps.readBoard(ctx, exec);
      } catch {
        return { kind: 'success', text: helpForMissingIndex() };
      }
      return { kind: 'success', text: renderModels(deps.modelGroups(board)) };
    }
    case 'login': {
      const result = await deps.loginNow(ctx, exec, {
        ...(parsed.mode ? { mode: parsed.mode } : {}),
        ...(parsed.cookie ? { cookie: parsed.cookie } : {}),
      });
      return { kind: result.status === 'ok' ? 'success' : 'error', text: renderLogin(result) };
    }
    case 'find':
      break;
    default:
      return { kind: 'error', text: usageText() };
  }

  let board;
  try {
    board = await deps.readBoard(ctx, exec);
  } catch {
    return { kind: 'success', text: helpForMissingIndex() };
  }

  const groups = deps.modelGroups(board);
  const resolved = deps.resolveModel(parsed.query, groups);
  if (!resolved.hit) {
    const candidates = resolved.scored.slice(0, 8).map(([, g]) => ({
      model: g.name,
      tasks: g.count,
      aliases: g.aliases,
    }));
    return { kind: 'error', text: ambiguousText(parsed, candidates, groups) };
  }

  const value = await deps.search(ctx, exec, {
    model: parsed.query,
    system: parsed.system,
    customer: parsed.customer,
    version: parsed.version,
    mainline: parsed.mainline,
    stage: parsed.stage,
    limit: parsed.limit ?? 3,
    verify: parsed.verify,
    all: parsed.all,
  });

  if (value.status === 'needs_setup') return { kind: 'success', text: helpForMissingIndex() };

  if (value.status === 'empty') {
    const lines = [`没有匹配的固件（机型=${value.resolvedModel}）。`];
    if (value.note) lines.push(`· ${value.note}`);
    lines.push(`放宽条件再试，或 /${COMMAND} models 看看写法。`);
    return { kind: 'success', text: lines.join('\n') };
  }

  const age = Date.now() - Date.parse(board.syncedAt ?? '');
  const lines = [deps.renderFind(value).trimEnd(), ''];
  lines.push(`· 索引 ${fmtAge(age)}同步`);
  if (parsed.notes.length) lines.push(`· ${parsed.notes.join('；')}`);
  lines.push(`更多: 加 --verify 校验链接体积 · -c SZ 换客户 · models 看全部机型`);
  return { kind: 'success', text: lines.join('\n') };
}

/**
 * 命令定义。
 * `recordInput: false`：原始输入不写进 command/run（可能含 cookie），结果本身已含解析后的查询。
 */
export function commandDefinition(ctx, deps) {
  return {
    name: COMMAND,
    description: '按机型/系统查 Teambition 归档固件（也支持 sync / status / models / login）',
    input: { hint: '帮我找 spring2pro 最新的固件' },
    recordInput: false,
    async handler(invocation) {
      try {
        return await runCommand(ctx, deps, invocation);
      } catch (error) {
        return { kind: 'error', text: `命令执行失败：${error?.message ?? error}` };
      }
    },
  };
}

export const commandName = COMMAND;
