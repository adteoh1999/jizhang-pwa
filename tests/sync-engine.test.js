// 2e 任务 5：上传引擎（js/sync.js createSync、js/rest.js upsertRows）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, BACKOFF_BASE_MS, BACKOFF_MAX_MS } from '../js/sync.js';
import { upsertRows, UPLOAD_COLUMNS } from '../js/rest.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';

const ME = 'u-1';
const SESSION = { access_token: 'tok-1', refresh_token: 'r', expires_at: 0, user_id: ME, email: 'me@x.com' };
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jsonRes = (status, obj) => new Response(obj === undefined ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// 假时钟：setTimer / clearTimer / advance
function fakeClock(start = Date.parse('2026-11-25T10:00:00Z')) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
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
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };

// 假服务器：记录请求；handler(table, rows, req) → Response。默认：全部 201 回原 id、updated_at
function fakeServer(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const rows = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), table, rows, init });
    if (handler) return handler(table, rows, { url: u, init, n: calls.length });
    return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
  };
  f.calls = calls;
  return f;
}

async function setup({ txCount = 0, owner = ME, server, getSession, online = true, appVersion = 'v-test', clock = fakeClock(), locks = null, extra = {} } = {}) {
  let n = 0;
  let t = Date.parse('2026-11-25T09:00:00Z');
  const db = createMemoryDb();
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  for (let i = 0; i < txCount; i++) {
    await store.saveTransaction({ kind: 'expense', amountMinor: 100 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  }
  if (owner) await store.setMeta('owner_user_id', owner);
  await store.setMeta('syncErrorVersion', appVersion);
  const fetchFn = server || fakeServer();
  const sessions = [];
  const onlineRef = { v: online };
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const sync = createSync({
    store, fetchFn, userId: ME, appVersion,
    getSession: getSession || (async (failedToken) => { sessions.push(failedToken); return { session: SESSION }; }),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    isOnline: () => onlineRef.v, win, doc, locks, ...extra,
  });
  return { db, store, sync, fetchFn, clock, sessions, onlineRef, win, doc };
}
const pendingTx = (store) => store.syncCounts().txPending;

// ---------- rest.upsertRows ----------
test('upsertRows：网址、headers、只送上传栏位（没有 user_id / dirty / sync_error），回 rows', async () => {
  const f = fakeServer();
  const row = { id: 'a', kind: 'expense', amount_minor: 1, category_id: 'food', occurred_on: '2026-11-20', note: '', created_at: 'c', updated_at: 'u', deleted: false, dirty: 1, sync_error: { code: 'x' }, user_id: 'evil', source: 'bot' };
  const r = await upsertRows(f, 'transactions', [row], 'tok-9');
  const c = f.calls[0];
  assert.equal(c.url, `${SUPABASE_URL}/rest/v1/transactions?on_conflict=user_id,id&columns=${UPLOAD_COLUMNS.transactions.join(',')}&select=id,updated_at`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.apikey, SUPABASE_KEY);
  assert.equal(c.init.headers.Authorization, 'Bearer tok-9');
  assert.equal(c.init.headers.Prefer, 'resolution=merge-duplicates,return=representation');
  assert.deepEqual(Object.keys(c.rows[0]).sort(), [...UPLOAD_COLUMNS.transactions].sort());
  assert.equal(r.status, 201);
  assert.deepEqual(r.rows, [{ id: 'a', updated_at: 'u' }]);
  assert.deepEqual(UPLOAD_COLUMNS.categories, ['id', 'kind', 'name', 'icon', 'sort', 'updated_at', 'deleted']);
});

test('upsertRows：错误回 status 与 PostgREST 的 code；网络错 / 超时 status 0', async () => {
  let r = await upsertRows(fakeServer(() => jsonRes(400, { code: '23514', message: 'x' })), 'transactions', [], 't');
  assert.deepEqual([r.status, r.errorCode, r.rows], [400, '23514', null]);
  r = await upsertRows(async () => { throw new Error('offline'); }, 'transactions', [], 't');
  assert.equal(r.status, 0);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort'))));
  r = await upsertRows(hang, 'transactions', [], 't', { timeoutMs: 30 });
  assert.equal(r.status, 0);
  r = await upsertRows(fakeServer(() => new Response('oops', { status: 500 })), 'transactions', [], 't');
  assert.deepEqual([r.status, r.errorCode], [500, null]);
});

// ---------- 引擎 ----------
test('3 笔待上传 → 1 个请求；之后 pending 0、状态 idle', async () => {
  const { sync, store, fetchFn } = await setup({ txCount: 3 });
  await sync.syncNow();
  const tx = fetchFn.calls.filter((c) => c.table === 'transactions');
  assert.equal(tx.length, 1);
  assert.equal(tx[0].rows.length, 3);
  assert.ok(tx[0].url.includes('on_conflict=user_id,id'));
  assert.ok(tx[0].rows.every((r) => !('user_id' in r) && !('dirty' in r) && !('sync_error' in r)));
  assert.equal(pendingTx(store), 0);
  assert.equal(sync.status().state, 'idle');
});

test('先传分类、再传账目；1200 笔 → 3 批（500 / 500 / 200）', async () => {
  const { sync, store, fetchFn } = await setup({ txCount: 0 });
  await store.saveCategory({ kind: 'expense', name: '宠物' });
  const rows = Array.from({ length: 1200 }, (_, i) => ({ kind: 'expense', amountMinor: 1 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' }));
  for (const r of rows) await store.saveTransaction(r);
  await sync.syncNow();
  assert.deepEqual(fetchFn.calls.map((c) => [c.table, c.rows.length]), [['categories', 1], ['transactions', 500], ['transactions', 500], ['transactions', 200]]);
  assert.equal(pendingTx(store), 0);
});

test('时钟快：回传 updated_at 比送出的早 → 本地写回服务器值', async () => {
  const server = fakeServer((table, rows) => jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: '2026-11-25T03:32:54.739959+00:00' }))));
  const { sync, store, db } = await setup({ txCount: 1, server });
  await sync.syncNow();
  const [t] = await db.getAll('transactions');
  assert.equal(t.updated_at, '2026-11-25T03:32:54.739Z');
  assert.equal(t.dirty, 0);
  assert.equal(pendingTx(store), 0);
});

test('整批 400 + 资料错（23514）→ 逐笔；只有坏那笔标 sync_error，其他 dirty 0', async () => {
  let bad;
  const server = fakeServer((table, rows) => {
    if (rows.length > 1 || rows[0].id === bad) return jsonRes(400, { code: '23514' });
    return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
  });
  const { sync, store, db } = await setup({ txCount: 3, server });
  bad = (await db.getAll('transactions'))[1].id;
  await sync.syncNow();
  const all = await db.getAll('transactions');
  assert.equal(all.find((r) => r.id === bad).sync_error.code, '23514');
  assert.ok(all.filter((r) => r.id !== bad).every((r) => r.dirty === 0 && !r.sync_error));
  assert.equal(server.calls.length, 1 + 3);
  assert.deepEqual([store.syncCounts().txErrors, sync.status().state], [1, 'idle']);
  assert.equal(sync.status().txErrors, 1);
});

test('非资料类 4xx（403、404、400+PGRST、没有 code）→ 不标任何列、状态 error、进退避', async () => {
  for (const res of [() => jsonRes(403, { code: '42501' }), () => jsonRes(404, { code: 'PGRST205' }), () => jsonRes(400, { code: 'PGRST102' }), () => new Response('x', { status: 413 })]) {
    const server = fakeServer(res);
    const { sync, store } = await setup({ txCount: 2, server });
    await sync.syncNow();
    assert.equal(server.calls.length, 1);
    assert.equal(store.syncCounts().errors, 0);
    assert.equal(pendingTx(store), 2);
    assert.equal(sync.status().state, 'error');
    assert.equal(sync.status().retryInMs, BACKOFF_BASE_MS);
  }
});

test('逐笔途中遇到 500 → 整轮停、不标', async () => {
  const server = fakeServer((table, rows, { n }) => (n === 1 ? jsonRes(400, { code: '23514' }) : jsonRes(500, {})));
  const { sync, store } = await setup({ txCount: 3, server });
  await sync.syncNow();
  assert.equal(server.calls.length, 2);
  assert.equal(store.syncCounts().errors, 0);
  assert.equal(sync.status().state, 'error');
});

test('500 → 退避 5 s、再失败 10 s …… 上限 300 s；成功后归零', async () => {
  let fail = true;
  const server = fakeServer((table, rows) => (fail ? jsonRes(503, {}) : jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })))));
  const clock = fakeClock();
  const { sync, store } = await setup({ txCount: 1, server, clock });
  await sync.syncNow();
  assert.equal(sync.status().retryInMs, 5000);
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const before = server.calls.length;
    await clock.advance(sync.status().retryInMs - 1);
    assert.equal(server.calls.length, before, `第 ${i} 次提早`);
    await clock.advance(1);
    assert.equal(server.calls.length, before + 1, `第 ${i} 次到时间`);
    seen.push(sync.status().retryInMs);
  }
  assert.deepEqual(seen, [10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(BACKOFF_MAX_MS, 300000);
  fail = false;
  await clock.advance(300000);
  assert.equal(pendingTx(store), 0);
  assert.equal(sync.status().state, 'idle');
  assert.equal(sync.status().retryInMs, 0);
});

test('0 / 408 / 429 也是暂时错误：退避、不标', async () => {
  for (const res of [async () => { throw new Error('net'); }, () => jsonRes(408, {}), () => jsonRes(429, {})]) {
    const server = fakeServer(res);
    const { sync, store } = await setup({ txCount: 1, server });
    await sync.syncNow();
    assert.equal(sync.status().state, 'error');
    assert.equal(store.syncCounts().errors, 0);
  }
});

test('401 → 带着失败的 token 拿新 session → 重试成功；一轮最多刷新一次（第二次 401 当错误、不无限循环）', async () => {
  let n = 0;
  const server = fakeServer((table, rows, { init }) => {
    n++;
    if (init.headers.Authorization === 'Bearer tok-1') return jsonRes(401, { code: 'PGRST301' });
    return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
  });
  const sessions = [];
  const getSession = async (failed) => { sessions.push(failed); return { session: failed ? { ...SESSION, access_token: 'tok-2' } : SESSION }; };
  const { sync, store } = await setup({ txCount: 1, server, getSession });
  await sync.syncNow();
  assert.deepEqual(sessions, [null, 'tok-1']);
  assert.equal(n, 2);
  assert.equal(pendingTx(store), 0);

  const always401 = fakeServer(() => jsonRes(401, { code: 'PGRST301' }));
  const s2 = [];
  const r = await setup({ txCount: 1, server: always401, getSession: async (f) => { s2.push(f); return { session: SESSION }; } });
  await r.sync.syncNow();
  assert.equal(always401.calls.length, 2);
  assert.equal(s2.length, 2);
  assert.equal(r.sync.status().state, 'error');
});

test('getSession 回 invalid → 状态 signed-out、不发请求、不退避；回 retry → error、退避', async () => {
  let r = await setup({ txCount: 1, getSession: async () => ({ invalid: true }) });
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 0);
  assert.equal(r.sync.status().state, 'signed-out');
  assert.equal(r.clock.pending(), 0);
  r = await setup({ txCount: 1, getSession: async () => ({ retry: true }) });
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 0);
  assert.equal(r.sync.status().state, 'error');
  assert.equal(r.sync.status().retryInMs, BACKOFF_BASE_MS);
});

test('401 刷新时回 invalid → signed-out', async () => {
  const server = fakeServer(() => jsonRes(401, {}));
  const r = await setup({ txCount: 1, server, getSession: async (f) => (f ? { invalid: true } : { session: SESSION }) });
  await r.sync.syncNow();
  assert.equal(r.sync.status().state, 'signed-out');
});

test('跑的时候叫 syncNow() 3 次 → 跑完只多跑 1 轮', async () => {
  let release;
  let first = true;
  const server = fakeServer(async (table, rows) => {
    if (first) { first = false; await new Promise((r) => { release = r; }); }
    return jsonRes(201, rows.map((r) => ({ id: r.id, updated_at: r.updated_at })));
  });
  const r = await setup({ txCount: 1, server });
  const p = r.sync.syncNow();
  await settle();
  await r.store.saveTransaction({ kind: 'expense', amountMinor: 5, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  r.sync.syncNow(); r.sync.syncNow(); r.sync.syncNow();
  release();
  await p;
  await settle();
  assert.equal(server.calls.filter((c) => c.table === 'transactions').length, 2);
  assert.equal(pendingTx(r.store), 0);
});

test('离线 → 不发请求、状态 offline；online 事件后上传', async () => {
  const r = await setup({ txCount: 1, online: false });
  r.sync.start();
  await r.clock.advance(5000);
  assert.equal(r.fetchFn.calls.length, 0);
  assert.equal(r.sync.status().state, 'offline');
  assert.equal(r.sync.status().txPending, 1);
  r.onlineRef.v = true;
  r.win.dispatchEvent(new Event('online'));
  await r.clock.advance(1000);
  assert.equal(r.fetchFn.calls.length, 1);
  assert.equal(r.sync.status().state, 'idle');
  r.sync.stop();
});

test('owner 不是这个账号（另一个账号 / 还没认领）→ 不发请求；B 登录而账本属于 A → 0 个上传请求', async () => {
  for (const [owner, state] of [['u-A', 'other-owner'], [null, 'unclaimed']]) {
    const r = await setup({ txCount: 2, owner });
    await r.sync.syncNow();
    assert.equal(r.fetchFn.calls.length, 0);
    assert.equal(r.sync.status().state, state);
  }
});

test('session 的账号和引擎建立时不同（别的分页换了账号）→ 停、不发请求', async () => {
  const r = await setup({ txCount: 1, getSession: async () => ({ session: { ...SESSION, user_id: 'u-9' } }) });
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 0);
  assert.equal(r.sync.status().state, 'stale');
});

test('防抖：1 秒内存 5 笔 → 1 轮；start 时跑一次', async () => {
  const r = await setup({ txCount: 0 });
  r.sync.start();
  await r.clock.advance(1000);
  const base = r.fetchFn.calls.length; // 没东西可传：0 个请求
  assert.equal(base, 0);
  for (let i = 0; i < 5; i++) {
    await r.store.saveTransaction({ kind: 'expense', amountMinor: 1 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
    await r.clock.advance(150);
  }
  await r.clock.advance(1000);
  assert.equal(r.fetchFn.calls.length, 1);
  assert.equal(r.fetchFn.calls[0].rows.length, 5);
  r.sync.stop();
});

test('退避期间：60 秒 / 回前景的触发不提早发请求；用户写入可以立刻试', async () => {
  const server = fakeServer(() => jsonRes(503, {}));
  const r = await setup({ txCount: 1, server });
  r.sync.start();
  await r.clock.advance(1000);
  assert.equal(server.calls.length, 1); // start 那轮失败 → 退避 5 s
  r.doc.dispatchEvent(new Event('visibilitychange'));
  r.sync.schedule();
  await r.clock.advance(2000);
  assert.equal(server.calls.length, 1); // 还在退避（5 s）
  await r.store.saveTransaction({ kind: 'expense', amountMinor: 9, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await r.clock.advance(1000);
  assert.equal(server.calls.length, 2);
  r.sync.stop();
});

test('5xx 期间连续触发，请求次数受退避限制', async () => {
  const server = fakeServer(() => jsonRes(500, {}));
  const r = await setup({ txCount: 1, server });
  r.sync.start();
  for (let i = 0; i < 60; i++) { r.sync.schedule(); await r.clock.advance(1000); }
  // 60 秒内：0、5、15、35 秒各一次（5+10+20 退避）
  assert.ok(server.calls.length <= 5, `请求 ${server.calls.length} 次`);
  r.sync.stop();
});

test('App 版本变了 → 先清掉 sync_error 重试一次；同版本不清', async () => {
  const r = await setup({ txCount: 1, appVersion: 'v-new' });
  const [t] = await r.store.pendingRows('transactions');
  await r.store.markSyncError('transactions', t.id, '23514', t.updated_at);
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 0); // 同版本：不清、没东西可传
  await r.store.setMeta('syncErrorVersion', 'v-old');
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 1);
  assert.equal(await r.store.getMeta('syncErrorVersion'), 'v-new');
  assert.equal(r.store.syncCounts().errors, 0);
});

test('subscribe：每轮结束通知一次状态；没东西传也会回 idle', async () => {
  const r = await setup({ txCount: 1 });
  const seen = [];
  const off = r.sync.subscribe((s) => seen.push(s.state));
  await r.sync.syncNow();
  assert.equal(seen.at(-1), 'idle');
  assert.ok(seen.includes('syncing'));
  off();
  await r.sync.syncNow();
  assert.equal(seen.filter((x) => x === 'idle').length, 1);
});

test('stop 之后：不再跑、不再排程、不再监听', async () => {
  const r = await setup({ txCount: 0 });
  r.sync.start();
  r.sync.stop();
  await r.store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  r.win.dispatchEvent(new Event('online'));
  await r.clock.advance(10000);
  await r.sync.syncNow();
  assert.equal(r.fetchFn.calls.length, 0);
});

test('Web Locks：另一个分页正在同步（ifAvailable 拿不到）→ 这轮跳过、不发请求', async () => {
  const used = [];
  const busy = { request: (name, opts, cb) => { used.push([name, opts]); return cb(null); } };
  const r = await setup({ txCount: 1, locks: busy });
  await r.sync.syncNow();
  assert.deepEqual(used, [['jizhang-sync', { ifAvailable: true }]]);
  assert.equal(r.fetchFn.calls.length, 0);
  const free = { request: (name, opts, cb) => cb({ name }) };
  const r2 = await setup({ txCount: 1, locks: free });
  await r2.sync.syncNow();
  assert.equal(r2.fetchFn.calls.length, 1);
});

test('上传请求与日志不含账目内容或 token', async () => {
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const r = await setup({ txCount: 1, server: fakeServer(() => jsonRes(400, { code: '23514', message: 'secret-note tok-1' })) });
    await r.sync.syncNow();
  } finally { console.warn = orig; }
  assert.ok(logs.length > 0);
  for (const l of logs) assert.doesNotMatch(l, /tok-1|secret-note/);
});
