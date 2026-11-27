// 2e-2 任务 8：同步引擎拉取（js/sync.js createSync 的拉取部分）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, POLL_MS, FULL_SYNC_EVERY_MS } from '../js/sync.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { defaultCategories } from '../js/model.js';

const ME = 'u-1';
const SESSION = { access_token: 'tok-1', refresh_token: 'r', expires_at: 0, user_id: ME, email: 'me@x.com' };
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock(start = Date.parse('2026-11-25T10:00:00Z')) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

// 服务器时间（微秒）→ 可比较的数字
const micros = (s) => {
  const frac = (/\.(\d+)/.exec(s) || [, ''])[1];
  return Date.parse(s.replace(/\.\d+/, '')) * 1000 + +(frac + '000000').slice(0, 6);
};
const ts = (sec, us = 0) => `2026-11-25T${String(8 + Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.${String(us).padStart(6, '0')}+00:00`;

/**
 * 假 PostgREST：tables = {transactions: [...], categories: [...]}（每列要有 id、server_updated_at）。
 * GET 照 order/limit/or/gt 模拟；POST（上传）回原 id、updated_at 并存进表。
 */
function fakePostgrest(tables = {}, { onGet } = {}) {
  // 默认分类预先在服务器上（真账号认领后就是这样）
  const cats = tables.categories || defaultCategories().map((c, i) => ({ ...c, server_updated_at: ts(i) }));
  const data = { transactions: [...(tables.transactions || [])], categories: [...cats], category_keywords: [...(tables.category_keywords || [])] };
  const gets = [];
  const posts = [];
  let clockUs = 0;
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    if (init.method === 'POST') {
      const rows = JSON.parse(init.body);
      posts.push({ table, rows });
      for (const r of rows) {
        const i = data[table].findIndex((x) => x.id === r.id);
        const rec = { ...r, server_updated_at: ts(40000 + ++clockUs) }; // 单调递增（真服务器是 clock_timestamp）
        if (i >= 0) data[table][i] = rec; else data[table].push(rec);
      }
      return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
    }
    gets.push({ url: String(url), table });
    if (onGet) { const r = await onGet(table, u, gets.length); if (r) return r; }
    let rows = [...data[table]].sort((a, b) => micros(a.server_updated_at) - micros(b.server_updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const gt = u.searchParams.get('server_updated_at');
    if (gt) { const v = micros(gt.slice(3)); rows = rows.filter((r) => micros(r.server_updated_at) > v); }
    const or = u.searchParams.get('or');
    if (or) {
      const m = /^\(server_updated_at\.gt\."([^"]+)",and\(server_updated_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)\)$/.exec(or);
      assert.ok(m, `or 格式不对：${or}`);
      const v = micros(m[1]);
      rows = rows.filter((r) => micros(r.server_updated_at) > v || (micros(r.server_updated_at) === v && r.id > m[3]));
    }
    return jsonRes(200, rows.slice(0, +u.searchParams.get('limit')));
  };
  f.gets = gets;
  f.posts = posts;
  f.data = data;
  return f;
}

const rtx = (i, o = {}) => ({
  id: fakeUuid(5000 + i), kind: 'expense', amount_minor: 100 + i, category_id: 'food', occurred_on: '2026-11-21', note: '',
  created_at: '2026-11-21T00:00:00+00:00', updated_at: '2026-11-25T07:00:00+00:00', deleted: false, server_updated_at: ts(i), ...o,
});

async function setup({ server = fakePostgrest(), clock = fakeClock(), owner = ME, meta = {}, getSession, onPulled } = {}) {
  let n = 0;
  let t = Date.parse('2026-11-25T09:00:00Z');
  const db = createMemoryDb();
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  if (owner) await store.setMeta('owner_user_id', owner);
  await store.setMeta('syncErrorVersion', 'v');
  for (const [k, v] of Object.entries(meta)) await store.setMeta(k, v);
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const sessions = [];
  const sync = createSync({
    store, fetchFn: server, userId: ME, appVersion: 'v',
    getSession: getSession || (async (f) => { sessions.push(f); return { session: SESSION }; }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    isOnline: () => true, win: new EventTarget(), doc, locks: null, onPulled,
  });
  return { db, store, sync, server, clock, doc, sessions };
}

test('keyset（Review Focus 5）：2500 列、第 1000/1001 列 server_updated_at 相同 → 全部收到、没重复、每页 ≤1000、拉到空页才停', async () => {
  const rows = [];
  for (let i = 0; i < 2500; i++) rows.push(rtx(i, { server_updated_at: i === 1000 ? ts(999) : ts(i) }));
  const server = fakePostgrest({ transactions: rows });
  const { sync, store } = await setup({ server });
  assert.equal(await sync.syncNow(), 'ok');
  assert.equal(store.transactions().length, 2500);
  const txGets = server.gets.filter((g) => g.table === 'transactions');
  assert.equal(txGets.length, 4); // 1000 + 1000 + 500 + 空页
  assert.equal(new Set(store.transactions().map((t) => t.id)).size, 2500);
  const cur = await store.getMeta('cursor:transactions');
  assert.equal(cur.ts, ts(2499));
  assert.equal(cur.id, fakeUuid(7499));
});

test('拉取顺序：先上传、再拉 categories、再拉 transactions、最后拉 category_keywords（3e）', async () => {
  const server = fakePostgrest();
  const order = [];
  const spy = async (url, init = {}) => { order.push(`${init.method || 'GET'} ${new URL(url).pathname.split('/').pop()}`); return server(url, init); };
  const { sync, store } = await setup({ server: spy });
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await sync.syncNow();
  assert.deepEqual(order.filter((x, i) => x !== order[i - 1]), ['POST transactions', 'GET categories', 'GET transactions', 'GET category_keywords']);
});

test('拉回较新的远端改动 → 盖掉本地已同步的列；拉回的旧版不盖掉本地未上传（sync_error）的改动', async () => {
  const server = fakePostgrest();
  const { sync, store } = await setup({ server });
  const a = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  const b = await store.saveTransaction({ kind: 'expense', amountMinor: 2, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await sync.syncNow();
  // 本地 b 又改了，但被服务器拒（sync_error，仍 dirty 1）
  const b2 = await store.saveTransaction({ kind: 'expense', amountMinor: 3, categoryId: 'food', occurredOn: '2026-11-20', note: '', id: b.id });
  await store.markSyncError('transactions', b.id, '23514', b2.updated_at);
  // 另一台：a 改成较新；b 被旧设备写成较旧的版本（server_updated_at 较新）
  const ia = server.data.transactions.findIndex((r) => r.id === a.id);
  server.data.transactions[ia] = { ...server.data.transactions[ia], amount_minor: 999, updated_at: '2026-11-25T11:00:00+00:00', server_updated_at: ts(50000) };
  const ib = server.data.transactions.findIndex((r) => r.id === b.id);
  server.data.transactions[ib] = { ...server.data.transactions[ib], amount_minor: 555, updated_at: '2026-11-24T00:00:00+00:00', server_updated_at: ts(50001) };
  assert.equal(await sync.syncNow(), 'ok');
  const byId = Object.fromEntries(store.transactions().map((t) => [t.id, t]));
  assert.equal(byId[a.id].amount_minor, 999);
  assert.equal(byId[b.id].amount_minor, 3);
  assert.equal(store.syncCounts().txErrors, 1);
});

test('拉取途中用户改了同一笔 → 用户的改动留下、仍待上传', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let mine;
  const server = fakePostgrest({}, {
    onGet: async (table, u, n) => {
      if (table === 'transactions' && n === 2) {
        await gate;
        return jsonRes(200, [rtx(0, { id: mine.id, amount_minor: 4242, updated_at: '2026-11-25T08:00:00+00:00' })]);
      }
      return null;
    },
  });
  const { sync, store } = await setup({ server });
  mine = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
  const p = sync.syncNow();
  await settle();
  await store.saveTransaction({ kind: 'expense', amountMinor: 77, categoryId: 'food', occurredOn: '2026-11-20', note: '', id: mine.id });
  release();
  await p;
  assert.equal(store.transactions()[0].amount_minor, 77);
  assert.equal(store.syncCounts().txPending, 1);
});

test('远端 deleted 较新 → 本地也删除、首页不显示', async () => {
  const server = fakePostgrest({ transactions: [rtx(1)] });
  const { sync, store } = await setup({ server });
  await sync.syncNow();
  assert.equal(store.transactions().length, 1);
  server.data.transactions[0] = rtx(1, { deleted: true, updated_at: '2026-11-25T09:30:00+00:00', server_updated_at: ts(500) });
  await sync.syncNow();
  assert.equal(store.transactions().length, 0);
});

test('整轮结束才通知画面一次；没有任何变化 → 0 次', async () => {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(rtx(i));
  const server = fakePostgrest({ transactions: rows });
  const { sync, store } = await setup({ server });
  let hits = 0;
  store.subscribe(() => hits++);
  await sync.syncNow();
  assert.equal(hits, 1);
  hits = 0;
  await sync.syncNow();
  assert.equal(hits, 0);
});

test('冷启动：没有游标 → 完整拉取（没有 gt）；之后的轮用游标减 60 秒；完整对账记 fullSyncAt', async () => {
  const server = fakePostgrest({ transactions: [rtx(0, { server_updated_at: '2026-11-25T08:00:00.123456+00:00' })] });
  const clock = fakeClock();
  const { sync, store } = await setup({ server, clock });
  await sync.syncNow();
  const first = server.gets.filter((g) => g.table === 'transactions')[0];
  assert.equal(new URL(first.url).searchParams.get('server_updated_at'), null);
  assert.equal(await store.getMeta('fullSyncAt'), clock.now());
  server.gets.length = 0;
  await sync.syncNow();
  const second = server.gets.filter((g) => g.table === 'transactions')[0];
  assert.equal(new URL(second.url).searchParams.get('server_updated_at'), 'gt.2026-11-25T07:59:00.123Z');
});

test('有游标的冷启动（新引擎）：24 小时内 → 增量；超过 24 小时 → 完整对账', async () => {
  const clock = fakeClock();
  const cursor = { ts: '2026-11-25T08:00:00.5+00:00', id: fakeUuid(1) };
  const meta = { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() - FULL_SYNC_EVERY_MS + 1000 };
  let r = await setup({ clock, meta });
  await r.sync.syncNow();
  const firstOf = (gets) => ['categories', 'transactions'].map((t) => new URL(gets.find((g) => g.table === t).url).searchParams.get('server_updated_at'));
  assert.deepEqual(firstOf(r.server.gets), ['gt.2026-11-25T07:59:00.500Z', 'gt.2026-11-25T07:59:00.500Z']);
  r = await setup({ clock, meta: { ...meta, fullSyncAt: clock.now() - FULL_SYNC_EVERY_MS } });
  await r.sync.syncNow();
  assert.deepEqual(firstOf(r.server.gets), [null, null]);
});

test('完整对账（S9）：本地 dirty 0 却不在服务器上 → 重新标待上传，并立刻再跑一轮传上去', async () => {
  const server = fakePostgrest();
  const { sync, store, clock } = await setup({ server });
  const a = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []); // 假装传过，其实服务器没有
  await store.markUploaded('categories', await store.pendingRows('categories'), []);
  assert.equal(await sync.syncNow(), 'ok');
  await clock.advance(2000);
  assert.ok(server.data.transactions.some((r) => r.id === a.id));
  assert.equal(store.syncCounts().pending, 0);
});

test('增量拉取不做 S9（只有完整对账才判断「不在服务器上」）', async () => {
  const clock = fakeClock();
  const cursor = { ts: ts(0), id: fakeUuid(1) };
  const { sync, store, server } = await setup({ clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() } });
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
  assert.equal(await sync.syncNow(), 'ok');
  await clock.advance(2000);
  assert.equal(store.syncCounts().pending, 0);
  assert.equal(server.posts.length, 0);
});

test('拉取 4xx（非 401）→ 丢掉该表游标、状态 error、下一轮完整拉取', async () => {
  const cursor = { ts: ts(0), id: fakeUuid(1) };
  const clock = fakeClock();
  let bad = true;
  const server = fakePostgrest({}, { onGet: (table) => (bad && table === 'transactions' ? jsonRes(400, { code: 'PGRST100' }) : null) });
  const { sync, store } = await setup({ server, clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() } });
  assert.equal(await sync.syncNow(), 'fail');
  assert.equal(sync.status().state, 'error');
  assert.equal(await store.getMeta('cursor:transactions'), null);
  assert.ok((await store.getMeta('cursor:categories')).ts); // 别的表游标不动（照常往前）
  bad = false;
  server.gets.length = 0;
  assert.equal(await sync.syncNow(), 'ok');
  const tx = server.gets.filter((g) => g.table === 'transactions')[0];
  assert.equal(new URL(tx.url).searchParams.get('server_updated_at'), null);
});

test('拉取 5xx / 网络错 → fail、游标保留；完整对账中途失败不拿不完整的 id 做 S9', async () => {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(rtx(i));
  let n = 0;
  const server = fakePostgrest({ transactions: rows }, { onGet: (table) => (table === 'transactions' && ++n === 2 ? jsonRes(503, {}) : null) });
  const { sync, store } = await setup({ server });
  assert.equal(await sync.syncNow(), 'fail');
  assert.equal(store.transactions().length, 1000);
  assert.equal((await store.getMeta('cursor:transactions')).ts, ts(999));
  assert.equal(await store.getMeta('fullSyncAt'), undefined); // 完整对账没跑完不算
  assert.equal(store.syncCounts().pending, 0); // 没有拿第 1 页的 id 去判断「不在服务器上」
});

test('拉取 401 → 刷新一次再拉；一轮内上传与拉取合计最多刷新一次', async () => {
  let n = 0;
  const server = fakePostgrest({}, { onGet: () => (++n <= 2 ? jsonRes(401, { code: 'PGRST301' }) : null) });
  const { sync, sessions } = await setup({ server });
  assert.equal(await sync.syncNow(), 'fail');
  assert.deepEqual(sessions, [null, 'tok-1']);
});

test('拉取时账本已换主人（applyRemote 回 null）→ halt、状态 other-owner', async () => {
  const server = fakePostgrest({ transactions: [rtx(0)] });
  const r = await setup({ server });
  const orig = r.store.applyRemote;
  r.store.applyRemote = async (...a) => { await r.store.setMeta('owner_user_id', 'u-2'); return orig(...a); };
  assert.equal(await r.sync.syncNow(), 'halt');
  assert.equal(r.sync.status().state, 'other-owner');
});

test('前景每 60 秒检查一次；背景不检查；尊重退避；stop 后不再检查', async () => {
  const clock = fakeClock();
  const server = fakePostgrest();
  const { sync, doc } = await setup({ server, clock });
  sync.start();
  await clock.advance(1500);
  const base = server.gets.length;
  assert.ok(base > 0);
  await clock.advance(POLL_MS);
  assert.ok(server.gets.length > base);
  doc.visibilityState = 'hidden';
  const hiddenBase = server.gets.length;
  await clock.advance(POLL_MS * 2);
  assert.equal(server.gets.length, hiddenBase);
  doc.visibilityState = 'visible';
  sync.stop();
  await clock.advance(POLL_MS * 2);
  assert.equal(server.gets.length, hiddenBase);
});

test('60 秒检查在退避期间不发请求', async () => {
  const clock = fakeClock();
  const server = fakePostgrest({}, { onGet: () => jsonRes(503, {}) });
  const { sync } = await setup({ server, clock });
  sync.start();
  await clock.advance(1500); // 第一轮失败 → 退避 5 s
  await clock.advance(5000); // 重试失败 → 退避 10 s
  await clock.advance(10_000); // 重试失败 → 20 s
  await clock.advance(20_000); // → 40 s
  await clock.advance(40_000); // → 80 s
  const before = server.gets.length;
  await clock.advance(POLL_MS); // 60 秒检查落在 80 秒退避中：不应多发
  assert.equal(server.gets.length, before);
});

test('服务器拉取永远回空、上传却成功（例如权限设错）→ 不会无限重传：一次 syncNow 最多补传一轮', async () => {
  let posts = 0;
  const server = async (url, init = {}) => {
    if (init.method === 'POST') {
      if (++posts > 20) throw new Error('无限循环');
      const rows = JSON.parse(init.body);
      return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
    }
    return jsonRes(200, []);
  };
  const { sync, store, clock } = await setup({ server });
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await sync.syncNow();
  await clock.advance(5000);
  await sync.syncNow();
  await clock.advance(5000);
  assert.ok(posts <= 4, `上传了 ${posts} 次`);
});

test('审核 M-1：拉到一半失败 → 已采用的照样通知画面一次；下一轮没新资料 → 0 次', async () => {
  const rows = [];
  for (let i = 0; i < 1500; i++) rows.push(rtx(i));
  let n = 0;
  const server = fakePostgrest({ transactions: rows }, { onGet: (table) => (table === 'transactions' && ++n === 2 ? jsonRes(503, {}) : null) });
  const { sync, store } = await setup({ server });
  let hits = 0;
  store.subscribe(() => hits++);
  assert.equal(await sync.syncNow(), 'fail');
  assert.equal(hits, 1);
  hits = 0;
  assert.equal(await sync.syncNow(), 'ok'); // 接着拉剩下的 500 → 1 次
  assert.equal(hits, 1);
  hits = 0;
  await sync.syncNow();
  assert.equal(hits, 0);
});

test('审核 S-1：游标到达超过 5 分钟 → 第一页直接从游标接着拉（keyset，不回退 60 秒）；游标没变不重写', async () => {
  const clock = fakeClock();
  const server = fakePostgrest({ transactions: [rtx(0), rtx(1)] });
  const { sync, store, db } = await setup({ server, clock });
  await sync.syncNow();
  const cur = await store.getMeta('cursor:transactions');
  assert.equal(cur.at, clock.now());
  // 马上再一轮：回退 60 秒；重拉到的最后一列就是游标 → 不写入
  server.gets.length = 0;
  const w = db.calls.length;
  await sync.syncNow();
  const first = new URL(server.gets.find((g) => g.table === 'transactions').url);
  assert.ok(first.searchParams.get('server_updated_at').startsWith('gt.'));
  assert.equal(db.calls.length, w);
  // 5 分钟后：从游标接着拉
  await clock.advance(5 * 60_000);
  server.gets.length = 0;
  await sync.syncNow();
  const g = new URL(server.gets.find((x) => x.table === 'transactions').url);
  assert.equal(g.searchParams.get('server_updated_at'), null);
  assert.ok(g.searchParams.get('or').includes(ts(1)));
  assert.equal(server.gets.filter((x) => x.table === 'transactions').length, 1); // 一个空页就结束
});

test('审核 S-1：游标到达时间在未来（时钟倒退）→ 照样回退 60 秒', async () => {
  const clock = fakeClock();
  const cursor = { ts: ts(0), id: fakeUuid(1), at: clock.now() + 3600_000 };
  const { sync, server } = await setup({ clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() } });
  await sync.syncNow();
  const g = new URL(server.gets.find((x) => x.table === 'transactions').url);
  assert.ok(g.searchParams.get('server_updated_at').startsWith('gt.'));
});

test('审核 S-2：stop() 在拉取请求途中 → 回来后不写入、不再发请求', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const server = fakePostgrest({ transactions: [rtx(0)] }, { onGet: async (table) => { if (table === 'transactions') await gate; return null; } });
  const { sync, store, db } = await setup({ server });
  const p = sync.syncNow();
  await settle();
  sync.stop();
  const w = db.calls.length;
  const g = server.gets.length;
  release();
  await p;
  assert.equal(db.calls.length, w);
  assert.equal(server.gets.length, g);
  assert.equal(store.transactions().length, 0);
});

test('审核 S-3：fullSyncAt 在未来（时钟曾经快）→ 当成到期、做完整对账', async () => {
  const clock = fakeClock();
  const cursor = { ts: ts(0), id: fakeUuid(1) };
  const { sync, server } = await setup({ clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() + 365 * 86400_000 } });
  await sync.syncNow();
  assert.equal(new URL(server.gets[0].url).searchParams.get('server_updated_at'), null);
});

test('S-7：拉取 401 一次 → 刷新后成功、资料采用', async () => {
  let n = 0;
  const server = fakePostgrest({ transactions: [rtx(0)] }, { onGet: () => (++n === 1 ? jsonRes(401, {}) : null) });
  const { sync, store, sessions } = await setup({ server });
  assert.equal(await sync.syncNow(), 'ok');
  assert.deepEqual(sessions, [null, 'tok-1']);
  assert.equal(store.transactions().length, 1);
});

test('S-7：拉取 429 → fail、游标保留', async () => {
  const cursor = { ts: ts(0), id: fakeUuid(1) };
  const clock = fakeClock();
  const server = fakePostgrest({}, { onGet: (t) => (t === 'transactions' ? jsonRes(429, {}) : null) });
  const { sync, store } = await setup({ server, clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() } });
  assert.equal(await sync.syncNow(), 'fail');
  assert.deepEqual(await store.getMeta('cursor:transactions'), cursor);
});

test('S-7：回应的列缺 server_updated_at → fail、不写入', async () => {
  const server = fakePostgrest({}, { onGet: (t) => (t === 'transactions' ? jsonRes(200, [{ ...rtx(0), server_updated_at: undefined }]) : null) });
  const { sync, store } = await setup({ server });
  assert.equal(await sync.syncNow(), 'fail');
  assert.equal(store.transactions().length, 0);
});

test('S-7：S9 不碰 dirty 1 / sync_error 的列', async () => {
  const server = fakePostgrest({}, { });
  const failPost = async (url, init = {}) => (init.method === 'POST' ? jsonRes(400, { code: '23514' }) : server(url, init));
  const { sync, store } = await setup({ server: failPost });
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await sync.syncNow();
  assert.equal(store.syncCounts().txErrors, 1);
  assert.equal(store.syncCounts().txPending, 0);
});

test('S-7：远端 deleted 较新但本地有更晚的未上传还原 → 本地赢', async () => {
  const server = fakePostgrest({ transactions: [rtx(0)] });
  const { sync, store } = await setup({ server });
  await sync.syncNow();
  const id = store.transactions()[0].id;
  await store.deleteTransaction(id);
  await store.restoreTransaction(id);
  // 另一台的删除（较旧，server_updated_at 较新）
  server.data.transactions[0] = rtx(0, { deleted: true, updated_at: '2026-11-25T08:30:00+00:00', server_updated_at: ts(30000) });
  await sync.syncNow();
  assert.equal(store.transactions().length, 1);
});

test('复审 1：服务器不认 or、一直回同一页 → fail、不无限发请求', async () => {
  const server = fakePostgrest({}, { onGet: (t) => (t === 'transactions' ? jsonRes(200, [rtx(0)]) : null) });
  const { sync } = await setup({ server });
  assert.equal(await sync.syncNow(), 'fail');
  assert.ok(server.gets.filter((g) => g.table === 'transactions').length <= 2);
});

test('2e-3 Task 2：一轮采用了远端资料 → 呼叫 onPulled 一次（通知其他分页）；没采用 → 不叫', async () => {
  let n = 0;
  const server = fakePostgrest({ transactions: [rtx(1), rtx(2)] });
  const { sync } = await setup({ server, onPulled: () => { n++; } });
  await sync.syncNow();
  assert.equal(n, 1);
  await sync.syncNow(); // 同样的资料：没有新采用
  assert.equal(n, 1);
});

test('2e-3 Task 3：diagnostics()——上次检查时间、结果、拉回笔数、连续失败、进行中', async () => {
  const server = fakePostgrest({ transactions: [rtx(1), rtx(2)] });
  const { sync, clock } = await setup({ server });
  assert.deepEqual(sync.diagnostics(), { lastRunAt: null, lastResult: null, failures: 0, runningSince: null, lastAdopted: 0 });
  const p = sync.syncNow();
  assert.equal(sync.diagnostics().runningSince, clock.now());
  await p;
  const d = sync.diagnostics();
  assert.equal(d.lastResult, 'ok');
  assert.equal(d.lastAdopted, 2);
  assert.equal(d.failures, 0);
  assert.equal(d.runningSince, null);
  assert.equal(d.lastRunAt, clock.now());
  await sync.syncNow();
  assert.equal(sync.diagnostics().lastAdopted, 0); // 每轮重算
});

// 2f-2 审核小事：别的分页刚清掉账本（登出／删号）→ 引擎不把游标、fullSyncAt 写回去
// 在写入那个 meta 键的前一刻，模拟别的分页 wipeLocal（owner 与账本代号都没了）
function wipeBeforeWriting(db, key) {
  const write = db.write.bind(db);
  let done = false;
  db.write = async (c) => {
    if (!done && c.meta && key in c.meta && !c.clearMeta) { done = true; await write({ clear: ['transactions', 'categories'], clearMeta: true, meta: { ledgerId: 'other-ledger' } }); }
    return write(c);
  };
}

test('2f-2 小事：拉取 4xx 要丢游标时，账本已被别的分页清掉 → 不写回游标、停下', async () => {
  const cursor = { ts: ts(0), id: fakeUuid(1) };
  const clock = fakeClock();
  const server = fakePostgrest({}, { onGet: (table) => (table === 'transactions' ? jsonRes(400, { code: 'PGRST100' }) : null) });
  const { sync, db } = await setup({ server, clock, meta: { 'cursor:transactions': cursor, 'cursor:categories': cursor, fullSyncAt: clock.now() } });
  wipeBeforeWriting(db, 'cursor:transactions');
  await sync.syncNow();
  assert.deepEqual(db.metaKeys(), ['ledgerId']);
  assert.equal(sync.status().state, 'other-owner');
});

test('2f-2 小事：完整对账做完要记 fullSyncAt 时，账本已被别的分页清掉 → 不写回、停下', async () => {
  const { sync, db } = await setup();
  wipeBeforeWriting(db, 'fullSyncAt');
  await sync.syncNow();
  assert.deepEqual(db.metaKeys(), ['ledgerId']);
  assert.equal(sync.status().state, 'other-owner');
});
