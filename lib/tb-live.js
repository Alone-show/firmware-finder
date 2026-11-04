/**
 * TB 实时检索：不依赖本地全量索引，按型号/现象直接查 /api/v2/search，
 * 只对命中的父任务抓子任务。用于 /firmware 的默认快速路径。
 */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

const LINK_FIELDS = ['固件下载地址', 'OSS 线刷地址', 'OSS OTA地址', 'OSS 差分包地址'];
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const nz = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SYSTEM_ALIASES = {
  android: ['android'],
  安卓: ['android'],
  debian: ['debian'],
  buildroot: ['buildroot'],
  linux: ['debian', 'buildroot'],
  'linux 系统': ['debian', 'buildroot'],
};

function normalizeFields(cfs, defs) {
  const fields = {};
  const scalar = (x) => (x && typeof x === 'object' ? (x.title ?? x.name ?? x) : x);
  for (const cf of cfs ?? []) {
    const def = defs[cf._customfieldId] ?? {};
    const name = def.name ?? cf._customfieldId;
    let val = cf.value;
    if (['dropDown', 'multipleChoice', 'lookup', 'lookup2'].includes(cf.type)) {
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

export function createTbClient({ cookie, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const headers = { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json' };
  const defsCache = new Map();

  async function get(url) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
    if (res.status === 401) throw new Error('Teambition 登录态失效，需要重新登录（/firmware login）');
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
  }

  async function defs(projectId) {
    if (defsCache.has(projectId)) return defsCache.get(projectId);
    const all = [];
    let token = '';
    for (let i = 0; i < 20; i += 1) {
      const json = await get(
        `https://www.teambition.com/api/v2/projects/${projectId}/customfields?pageSize=200${
          token ? `&pageToken=${encodeURIComponent(token)}` : ''
        }`,
      );
      all.push(...(json.result ?? []));
      if (!json.nextPageToken) break;
      token = json.nextPageToken;
    }
    const map = Object.fromEntries(all.map((item) => [item._id, item]));
    defsCache.set(projectId, map);
    return map;
  }

  /** 搜索一页 10 条；pages 控制翻页深度 */
  async function search(projectId, q, pages = 3) {
    const out = [];
    const seen = new Set();
    for (let page = 1; page <= pages; page += 1) {
      let json;
      try {
        json = await get(
          `https://www.teambition.com/api/v2/search?_projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&page=${page}`,
        );
      } catch (error) {
        if (!out.length) throw error;
        break;
      }
      const rows = Array.isArray(json) ? json : json.result ?? [];
      if (!rows.length) break;
      let added = 0;
      for (const row of rows) {
        if (!row?._id || seen.has(row._id)) continue;
        seen.add(row._id);
        out.push(row);
        added += 1;
      }
      if (!added) break;
    }
    return out;
  }

  async function task(id) {
    const json = await get(`https://www.teambition.com/api/v2/tasks/${encodeURIComponent(id)}`);
    return json;
  }

  async function subtasks(id) {
    const out = [];
    let token = '';
    for (let i = 0; i < 10; i += 1) {
      const json = await get(
        `https://www.teambition.com/api/v2/tasks/${encodeURIComponent(id)}/subtasks?pageSize=100${
          token ? `&pageToken=${encodeURIComponent(token)}` : ''
        }`,
      );
      out.push(...(json.result ?? []));
      if (!json.nextPageToken) break;
      token = json.nextPageToken;
    }
    return out;
  }

  return { headers, defs, search, task, subtasks };
}

function normalizeTask(raw, defs) {
  const fields = normalizeFields(raw.customfields, defs);
  const stage = raw.taskflowstatus?.name ?? raw.stage?.name ?? '';
  return {
    id: raw._id,
    title: String(raw.content ?? '').trim(),
    url: `https://www.teambition.com/task/${raw._id}`,
    stage,
    updated: raw.updated ?? '',
    created: raw.created ?? '',
    isDone: raw.isDone === true,
    subtaskCount: raw.subtaskCount ?? { total: 0, done: 0 },
    parentId: raw._taskId ?? raw.parentTaskId ?? (Array.isArray(raw.ancestorIds) && raw.ancestorIds.length ? raw.ancestorIds[raw.ancestorIds.length - 1] : ''),
    fields,
    note: String(raw.note ?? ''),
  };
}

export function isVersionParent(task) {
  const f = task?.fields ?? {};
  if (asList(f['固件版本']).length) return true;
  if (String(task?.title ?? '').includes('【版本迭代】')) return true;
  return LINK_FIELDS.some((key) => asList(f[key]).length);
}

function matchSystem(task, system) {
  const q = String(system ?? '').trim().toLowerCase();
  if (!q) return true;
  const accepted = SYSTEM_ALIASES[q] ?? [q];
  const list = asList(task.fields?.['操作系统']).map((x) => String(x).toLowerCase());
  if (!list.length) return true;
  return list.some((x) => accepted.some((a) => x.includes(a)));
}

function matchCustomer(task, customer) {
  if (!customer) return true;
  return asList(task.fields?.['客户ID'])
    .map((x) => String(x).toUpperCase())
    .some((x) => x.includes(String(customer).toUpperCase()));
}

function haystack(task) {
  return nz(
    [
      task.title,
      asList(task.fields?.['机型']).join(' '),
      asList(task.fields?.['固件版本']).join(' '),
      LINK_FIELDS.map((k) => asList(task.fields?.[k]).join(' ')).join(' '),
      task.note ?? '',
    ].join(' '),
  );
}

function matchModel(task, needles) {
  if (!needles?.length) return true;
  const hay = haystack(task);
  return needles.some((needle) => needle && hay.includes(needle));
}

function modelSearchQueries(model) {
  const raw = String(model ?? '').trim();
  if (!raw) return [];
  const out = new Set([raw]);
  if (/SP2/i.test(raw)) out.add(raw.replace(/SP2/gi, 'SPRING2'));
  if (/SPRING2/i.test(raw)) out.add(raw.replace(/SPRING2/gi, 'SP2'));
  if (/APOLLO2/i.test(raw)) out.add(raw.replace(/APOLLO2/gi, 'APOLLO'));
  else if (/APOLLO/i.test(raw)) out.add(raw.replace(/APOLLO/gi, 'APOLLO2'));
  return [...out].filter((x) => x.length >= 3);
}

function modelAliases(model) {
  const base = nz(model);
  const out = new Set([base]);
  if (base.includes('spring2')) out.add(base.replaceAll('spring2', 'sp2'));
  if (base.includes('sp2')) out.add(base.replaceAll('sp2', 'spring2'));
  if (base.includes('apollo2')) out.add(base.replaceAll('apollo2', 'apollo'));
  if (base.includes('apollo')) out.add(base.replaceAll('apollo', 'apollo2'));
  return [...out].filter(Boolean);
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
 * 实时检索：按型号/现象搜索 -> 拉详情 -> 只对匹配的版本任务抓子任务。
 * @returns {{records, parents, otherCustomers, queries}}
 */
export async function findLiveRecords({
  client,
  projectId,
  model = '',
  query = '',
  system = '',
  customer = 'CP',
  pages = 2,
  maxHits = 60,
  maxParents = 30,
} = {}) {
  const queries = [];
  if (model) {
    queries.push(...modelSearchQueries(model));
  } else if (query) {
    queries.push(query);
  }
  if (!queries.length) return { records: [], parents: [], otherCustomers: [], queries: [] };

  const batches = await Promise.all([...new Set(queries)].map((q) => client.search(projectId, q, pages).catch(() => [])));
  const hits = [];
  const seen = new Set();
  for (const rows of batches) {
    for (const row of rows) {
      if (!row?._id || seen.has(row._id)) continue;
      seen.add(row._id);
      hits.push(row);
      if (hits.length >= maxHits) break;
    }
    if (hits.length >= maxHits) break;
  }

  const defs = await client.defs(projectId);
  const direct = hits.map((row) => normalizeTask(row, defs));
  const details = [];
  const needDetail = [];
  for (const task of direct) {
    if (!task.parentId && isVersionParent(task)) {
      details.push(task);
    } else if (needDetail.length < 25) {
      needDetail.push(task);
    }
  }
  const fetched = await mapPool(needDetail, 8, async (task) => {
    try {
      return normalizeTask(await client.task(task.id), defs);
    } catch {
      return task;
    }
  });
  details.push(...fetched);

  const byId = new Map(details.filter(Boolean).map((task) => [task.id, task]));
  const parentCache = new Map();
  const getParent = async (id) => {
    if (!id) return null;
    if (byId.has(id)) return byId.get(id);
    if (parentCache.has(id)) return parentCache.get(id);
    try {
      const parent = normalizeTask(await client.task(id), defs);
      byId.set(id, parent);
      parentCache.set(id, parent);
      return parent;
    } catch {
      return null;
    }
  };

  const normalized = [];
  for (const task of details) {
    if (!task) continue;
    const parent = task.parentId ? await getParent(task.parentId) : task;
    if (!parent) continue;
    if (!isVersionParent(parent)) continue;
    if (!matchModel(parent, model ? modelAliases(model) : [])) continue;
    if (!matchSystem(parent, system)) continue;
    normalized.push({ task, parent });
  }

  // 客户口径：默认 CP，但要统计其他客户
  const pool = new Map();
  for (const { parent } of normalized) {
    for (const c of asList(parent.fields?.['客户ID'])) {
      const key = String(c);
      pool.set(key, (pool.get(key) ?? 0) + 1);
    }
  }
  const requested = String(customer ?? '').trim();
  const customerDefaulted = !requested;
  const effective = customerDefaulted ? 'CP' : requested;
  const unlimited = /^(all|\*|不限)$/i.test(effective);
  const otherCustomers = [...pool.entries()]
    .filter(([c]) => !unlimited && !c.toUpperCase().includes(effective.toUpperCase()))
    .map(([c, count]) => ({ customer: c, count }))
    .sort((a, b) => b.count - a.count);

  const picked = normalized.filter(({ parent }) => unlimited || matchCustomer(parent, effective));
  // 同一父任务只抓一次子任务
  const parents = [];
  const parentSeen = new Set();
  for (const item of picked) {
    if (parentSeen.has(item.parent.id)) continue;
    parentSeen.add(item.parent.id);
    parents.push(item.parent);
  }

  const subsByParent = new Map();
  await mapPool(parents.slice(0, maxParents), 6, async (parent) => {
    try {
      subsByParent.set(parent.id, await client.subtasks(parent.id));
    } catch {
      subsByParent.set(parent.id, []);
    }
  });

  const records = [];
  const parentsWithSubs = [];
  for (const parent of parents) {
    const rawSubs = subsByParent.get(parent.id) ?? [];
    if (!rawSubs.length) continue;
    parentsWithSubs.push(parent);
    for (const raw of rawSubs) {
      const status = raw.taskflowstatus?.name ?? '';
      records.push({
        subtask: {
          id: raw._id,
          parentId: parent.id,
          content: String(raw.content ?? '').trim(),
          note: String(raw.note ?? ''),
          status,
          isDone: raw.isDone === true,
          created: raw.created ?? '',
          updated: raw.updated ?? '',
          accomplished: raw.accomplished ?? '',
          executor: raw.executor?.name ?? '',
          uniqueId: raw.uniqueId ?? null,
          url: `https://www.teambition.com/task/${raw._id}`,
        },
        parent,
      });
    }
  }

  return {
    records,
    parents: parentsWithSubs,
    otherCustomers,
    customerDefaulted,
    customer: effective,
    queries: [...new Set(queries)],
  };
}
