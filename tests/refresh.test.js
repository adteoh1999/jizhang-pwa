// 2e 任务 2：token 刷新（锁、只有明确失效才算登出）、服务器登出（js/auth.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getValidSession, refreshSession, logoutServer, signOut, saveSession, loadSession, toSession, withLock,
  INVALID_REFRESH_CODES,
} from '../js/auth.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const OLD = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: NOW + 30_000, user_id: 'u-1', email: 'me@x.com', platform: 'pwa' };
const NEW_BODY = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, expires_at: 1, user: { id: 'u-1', email: 'me@x.com' } };
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(handler, { delayMs = 0 } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (handler instanceof Error) throw handler;
    return handler(String(url), init);
  };
  f.calls = calls;
  return f;
}
// 假 Web Locks：同名串行
function fakeLocks() {
  const tails = new Map();
  const used = [];
  return {
    used,
    request(name, fn) {
      used.push(name);
      const prev = tails.get(name) || Promise.resolve();
      const run = prev.then(() => fn());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}
async function setup(session = OLD) {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  if (session) await saveSession(store, session);
  return store;
}
const opts = (extra = {}) => ({ now: () => NOW, locks: fakeLocks(), ...extra });

test('还有 10 分钟 → 不发请求，回原 session', async () => {
  const store = await setup({ ...OLD, expires_at: NOW + 600_000 });
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  const r = await getValidSession(store, f, opts());
  assert.equal(f.calls.length, 0);
  assert.equal(r.session.access_token, 'old-access');
});

test('剩 30 秒 → 刷新 1 次，存新 session，expires_at 是「现在 + expires_in」毫秒', async () => {
  const store = await setup();
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  const locks = fakeLocks();
  const r = await getValidSession(store, f, opts({ locks }));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`);
  assert.deepEqual(f.calls[0].body, { refresh_token: 'old-refresh' });
  assert.equal(f.calls[0].init.headers.apikey, SUPABASE_KEY);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(r.session.access_token, 'new-access');
  assert.equal(r.session.expires_at, NOW + 3600_000);
  assert.deepEqual(locks.used, ['jizhang-auth']);
  const saved = await loadSession(store);
  assert.equal(saved.refresh_token, 'new-refresh');
  assert.equal(saved.invalid, undefined);
});

test('同时叫两次 → 只发 1 次刷新（第二次锁内重读拿到新的）', async () => {
  const store = await setup();
  const f = fakeFetch(() => jsonRes(200, NEW_BODY), { delayMs: 20 });
  const o = opts();
  const [a, b] = await Promise.all([getValidSession(store, f, o), getValidSession(store, f, o)]);
  assert.equal(f.calls.length, 1);
  assert.equal(a.session.access_token, 'new-access');
  assert.equal(b.session.access_token, 'new-access');
});

test('没有 Web Locks 时用分页内的后备锁，同样只刷新 1 次', async () => {
  const store = await setup();
  const f = fakeFetch(() => jsonRes(200, NEW_BODY), { delayMs: 20 });
  const o = { now: () => NOW, locks: null };
  const [a, b] = await Promise.all([getValidSession(store, f, o), getValidSession(store, f, o)]);
  assert.equal(f.calls.length, 1);
  assert.equal(b.session.access_token, a.session.access_token);
});

test('后备锁：前一个丢错不会卡住后一个', async () => {
  await assert.rejects(withLock('t-lock', async () => { throw new Error('x'); }, null));
  assert.equal(await withLock('t-lock', async () => 7, null), 7);
});

test('400 + 名单内的 error_code → invalid；session 被标 invalid（不删）', async () => {
  for (const code of ['refresh_token_already_used', 'session_expired', 'refresh_token_not_found']) {
    const store = await setup();
    const f = fakeFetch(() => jsonRes(400, { code: 400, error_code: code, msg: 'x' }));
    const r = await getValidSession(store, f, opts());
    assert.deepEqual(r, { invalid: true }, code);
    const saved = await loadSession(store);
    assert.equal(saved.invalid, true);
    assert.equal(saved.access_token, 'old-access');
  }
});

test('失效之后再叫 3 次 → 刷新请求总共只有 1 次；冷启动（重开 store）后仍 invalid、不发请求', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await saveSession(store, OLD);
  const f = fakeFetch(() => jsonRes(400, { error_code: 'session_not_found' }));
  for (let i = 0; i < 4; i++) assert.deepEqual(await getValidSession(store, f, opts()), { invalid: true });
  assert.equal(f.calls.length, 1);
  const store2 = createStore({ db });
  await store2.init();
  assert.deepEqual(await getValidSession(store2, f, opts()), { invalid: true });
  assert.equal(f.calls.length, 1);
});

test('重新登录（saveSession 新 session）后 invalid 消失、可照常使用', async () => {
  const store = await setup({ ...OLD, invalid: true });
  await saveSession(store, toSession(NEW_BODY, 'me@x.com', NOW));
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  const r = await getValidSession(store, f, opts());
  assert.equal(r.session.access_token, 'new-access');
  assert.equal(f.calls.length, 0);
});

test('没有 session → invalid、不发请求', async () => {
  const store = await setup(null);
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  assert.deepEqual(await getValidSession(store, f, opts()), { invalid: true });
  assert.equal(f.calls.length, 0);
});

test('网络错、429、500、400 没 error_code、400 validation_failed → retry，session 不变', async () => {
  const cases = [
    new Error('offline'),
    () => jsonRes(429, { error_code: 'over_request_rate_limit' }),
    () => jsonRes(500, {}),
    () => new Response('not json', { status: 400 }),
    () => jsonRes(400, { error_code: 'validation_failed' }),
    () => jsonRes(200, { access_token: 'x' }), // 200 但缺栏位
  ];
  for (const h of cases) {
    const store = await setup();
    const r = await getValidSession(store, fakeFetch(h), opts());
    assert.deepEqual(r, { retry: true });
    assert.deepEqual(await loadSession(store), OLD);
  }
  assert.equal(INVALID_REFRESH_CODES.includes('validation_failed'), false);
});

test('failedToken 等于目前的 → 就算没过期也刷新；不同（别的分页已刷新）→ 直接用目前的', async () => {
  const fresh = { ...OLD, expires_at: NOW + 600_000 };
  let store = await setup(fresh);
  let f = fakeFetch(() => jsonRes(200, NEW_BODY));
  let r = await getValidSession(store, f, opts({ failedToken: 'old-access' }));
  assert.equal(f.calls.length, 1);
  assert.equal(r.session.access_token, 'new-access');

  store = await setup(fresh);
  f = fakeFetch(() => jsonRes(200, NEW_BODY));
  r = await getValidSession(store, f, opts({ failedToken: 'some-older-access' }));
  assert.equal(f.calls.length, 0);
  assert.equal(r.session.access_token, 'old-access');
});

test('刷新失败的 console 讯息不含 token 字串', async () => {
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const store = await setup();
    await getValidSession(store, fakeFetch(() => jsonRes(400, { error_code: 'session_expired', msg: 'old-refresh' })), opts());
    await refreshSession(fakeFetch(() => jsonRes(500, { msg: 'old-refresh' })), 'old-refresh', 'me@x.com', NOW);
  } finally { console.warn = orig; }
  assert.ok(logs.length >= 2);
  for (const l of logs) {
    assert.doesNotMatch(l, /old-refresh|old-access|new-access|new-refresh/);
  }
  assert.ok(logs.some((l) => l.includes('400') && l.includes('session_expired')));
});

test('logoutServer：scope=local、带 Bearer、2 秒超时、出错不丢', async () => {
  const f = fakeFetch(() => new Response(null, { status: 204 }));
  await logoutServer(f, 'acc-1');
  assert.equal(f.calls[0].url, `${SUPABASE_URL}/auth/v1/logout?scope=local`);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer acc-1');
  assert.equal(f.calls[0].init.headers.apikey, SUPABASE_KEY);
  await logoutServer(fakeFetch(new Error('offline')), 'acc-1'); // 不丢错
  // 超时：fetch 永远不回，但会被 abort
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort'))));
  const t0 = Date.now();
  await logoutServer(hang, 'acc-1', { timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
});

test('signOut：先停同步、拿锁、在线就通知服务器，再清 session、reload', async () => {
  const store = await setup({ ...OLD, expires_at: NOW + 600_000 });
  const order = [];
  const f = fakeFetch(() => { order.push('logout'); return new Response(null, { status: 204 }); });
  const locks = fakeLocks();
  const ok = await signOut(store, () => order.push('reload'), {
    fetchFn: f, locks, stopSync: () => order.push('stop'), isOnline: () => true,
  });
  assert.equal(ok, true);
  assert.deepEqual(order, ['stop', 'logout', 'reload']);
  assert.deepEqual(locks.used, ['jizhang-auth']);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer old-access');
  assert.equal(await loadSession(store), null);
});

test('signOut：服务器登出丢错 → 仍登出；离线 → 不发请求；已失效的 session → 不发请求', async () => {
  let store = await setup();
  let reloaded = false;
  assert.equal(await signOut(store, () => { reloaded = true; }, { fetchFn: fakeFetch(new Error('x')), locks: fakeLocks(), isOnline: () => true }), true);
  assert.equal(reloaded, true);
  assert.equal(await loadSession(store), null);

  store = await setup();
  let f = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await signOut(store, () => {}, { fetchFn: f, locks: fakeLocks(), isOnline: () => false }), true);
  assert.equal(f.calls.length, 0);

  store = await setup({ ...OLD, invalid: true });
  f = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await signOut(store, () => {}, { fetchFn: f, locks: fakeLocks(), isOnline: () => true }), true);
  assert.equal(f.calls.length, 0);
  assert.equal(await loadSession(store), null);
});

test('signOut 与刷新用同一把锁：刷新进行中登出，会等刷新结束再清（不会被刷新写回 session）', async () => {
  const store = await setup();
  const locks = fakeLocks();
  const f = fakeFetch(() => jsonRes(200, NEW_BODY), { delayMs: 30 });
  const p1 = getValidSession(store, f, { now: () => NOW, locks });
  const p2 = signOut(store, () => {}, { fetchFn: fakeFetch(() => new Response(null, { status: 204 })), locks, isOnline: () => true });
  await Promise.all([p1, p2]);
  assert.equal(await loadSession(store), null);
});
