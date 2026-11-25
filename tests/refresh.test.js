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

// ---------- 任务 2 审核修正 ----------
import { bootTarget } from '../js/auth.js';

test('读本机 session 丢错 → {retry:true}，不往外丢', async () => {
  const bad = { getMeta: async () => { throw new Error('idb'); }, setMeta: async () => {} };
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  assert.deepEqual(await getValidSession(bad, f, opts()), { retry: true });
  assert.equal(f.calls.length, 0);
});

test('刷新成功但存不进本机 → 仍回新 session（这一轮能用），不往外丢', async () => {
  const store = await setup();
  const real = store.setMeta;
  store.setMeta = async () => { throw new Error('disk'); };
  const orig = console.warn;
  console.warn = () => {};
  let r;
  try { r = await getValidSession(store, fakeFetch(() => jsonRes(200, NEW_BODY)), opts()); } finally { console.warn = orig; store.setMeta = real; }
  assert.equal(r.session.access_token, 'new-access');
});

test('标记失效时写入失败 → 仍回 {invalid:true}', async () => {
  const store = await setup();
  store.setMeta = async () => { throw new Error('disk'); };
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await getValidSession(store, fakeFetch(() => jsonRes(400, { error_code: 'session_expired' })), opts()), { invalid: true });
  } finally { console.warn = orig; }
});

test('locks.request 本身丢错 → signOut 不用锁照样清 session、回 true', async () => {
  const store = await setup();
  const locks = { request: () => Promise.reject(new Error('InvalidStateError')) };
  let reloaded = false;
  assert.equal(await signOut(store, () => { reloaded = true; }, { fetchFn: fakeFetch(() => new Response(null, { status: 204 })), locks, isOnline: () => true }), true);
  assert.equal(reloaded, true);
  assert.equal(await loadSession(store), null);
});

test('failedToken 不同但目前的也快过期 → 照样刷新', async () => {
  const store = await setup(); // 剩 30 秒
  const f = fakeFetch(() => jsonRes(200, NEW_BODY));
  const r = await getValidSession(store, f, opts({ failedToken: 'some-older-access' }));
  assert.equal(f.calls.length, 1);
  assert.equal(r.session.access_token, 'new-access');
});

test('failedToken 相同 + 回 invalid → invalid；相同 + 网络错 → retry', async () => {
  let store = await setup({ ...OLD, expires_at: NOW + 600_000 });
  assert.deepEqual(await getValidSession(store, fakeFetch(() => jsonRes(400, { error_code: 'session_not_found' })), opts({ failedToken: 'old-access' })), { invalid: true });
  store = await setup({ ...OLD, expires_at: NOW + 600_000 });
  assert.deepEqual(await getValidSession(store, fakeFetch(new Error('offline')), opts({ failedToken: 'old-access' })), { retry: true });
});

test('刷新途中别处存了新 session（例如重新登录）→ 收到 invalid 也不盖掉新的，回新的', async () => {
  const store = await setup();
  const newer = { ...OLD, access_token: 'login-access', refresh_token: 'login-refresh', expires_at: NOW + 3600_000 };
  const f = fakeFetch(async () => {
    await store.setMeta('session', newer); // 不经过锁
    return jsonRes(400, { error_code: 'refresh_token_already_used' });
  });
  const r = await getValidSession(store, f, opts());
  assert.equal(r.session.access_token, 'login-access');
  const saved = await loadSession(store);
  assert.equal(saved.invalid, undefined);
  assert.equal(saved.refresh_token, 'login-refresh');
});

test('失效名单 6 个都算 invalid；401 / 403 带名单内的 code 仍是 retry', async () => {
  assert.equal(INVALID_REFRESH_CODES.length, 6);
  for (const code of INVALID_REFRESH_CODES) {
    const store = await setup();
    assert.deepEqual(await getValidSession(store, fakeFetch(() => jsonRes(400, { error_code: code })), opts()), { invalid: true }, code);
  }
  for (const status of [401, 403]) {
    const store = await setup();
    assert.deepEqual(await getValidSession(store, fakeFetch(() => jsonRes(status, { error_code: 'session_not_found' })), opts()), { retry: true }, String(status));
  }
});

test('刷新回来的 user_id 和原本不同 → retry、session 不变', async () => {
  const store = await setup();
  const r = await getValidSession(store, fakeFetch(() => jsonRes(200, { ...NEW_BODY, user: { id: 'u-OTHER' } })), opts());
  assert.deepEqual(r, { retry: true });
  assert.deepEqual(await loadSession(store), OLD);
});

test('带 invalid 的 session：loadSession 仍回物件、bootTarget 仍是 app（用户决定 1：不踢出）', async () => {
  const store = await setup({ ...OLD, invalid: true });
  const s = await loadSession(store);
  assert.equal(s.invalid, true);
  assert.equal(bootTarget(s), 'app');
});

test('日志只印规矩的 error_code（小写字母、数字、底线，≤64），其他印「其他」', async () => {
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    await refreshSession(fakeFetch(() => jsonRes(400, { error_code: 'X<script>secret-token' })), 'r', 'e', NOW);
    await refreshSession(fakeFetch(() => jsonRes(400, { error_code: 'session_expired' })), 'r', 'e', NOW);
  } finally { console.warn = orig; }
  assert.doesNotMatch(logs[0], /script|secret/);
  assert.match(logs[0], /其他/);
  assert.match(logs[1], /session_expired/);
});

test('刷新途中 session 被别处清掉（登出）→ 回 invalid、不把旧的写回来', async () => {
  const store = await setup();
  const f = fakeFetch(async () => {
    await store.setMeta('session', null);
    return jsonRes(400, { error_code: 'session_not_found' });
  });
  assert.deepEqual(await getValidSession(store, f, opts()), { invalid: true });
  assert.equal(await loadSession(store), null);
});

// ---------- 2f 整体审核 I-1：登出等锁超时直接清之后，卡住的刷新不能把登录写回去 ----------
test('刷新卡住 → 登出等锁超时直接清 → 刷新回来也不写回 session（同一个分页、另一个分页都一样）', async () => {
  for (const where of ['same', 'other']) {
    const db = createMemoryDb();
    const store = createStore({ db });
    await store.init();
    await store.setMetas({ session: OLD, owner_user_id: 'u-1', lastUserId: 'u-1' });
    const refresher = where === 'same' ? store : createStore({ db });
    if (refresher !== store) await refresher.init();
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = fakeFetch(async () => { await gate; return jsonRes(200, NEW_BODY); });
    const p1 = getValidSession(refresher, f, { now: () => NOW, locks: null });
    while (f.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    const orig = console.warn;
    console.warn = () => {};
    let ok;
    try {
      ok = await signOut(store, () => {}, { locks: null, waitMs: 20, isOnline: () => false });
    } finally { console.warn = orig; }
    assert.equal(ok, true, where);
    release();
    const r = await p1;
    assert.equal(await loadSession(store), null, `${where}：登出后不能被刷新写回`);
    assert.equal(r.session, undefined, `${where}：刷新不能回一个已被登出的 session`);
  }
});

// ---------- 2f 复核建议 1、2 ----------
test('读 session 与读账本代号之间刚好被登出清掉 → 刷新回来也不写回（先读代号再读 session）', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session: OLD, owner_user_id: 'u-1' });
  const other = createStore({ db });
  await other.init();
  const real = store.getMeta;
  let wiped = false;
  store.getMeta = async (k) => {
    const v = await real(k);
    if (k === 'session' && !wiped) { wiped = true; await other.wipeLocal(); }
    return v;
  };
  const r = await getValidSession(store, fakeFetch(() => jsonRes(200, NEW_BODY)), { now: () => NOW, locks: null });
  store.getMeta = real;
  assert.equal(wiped, true);
  assert.equal(await loadSession(store), null, '不能写回已清空的账本');
  assert.equal(r.session, undefined);
});

test('刷新卡住时别的分页换成另一个账号（resetForAccount）→ 不写回、新账号的 session 不被盖掉', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session: OLD, owner_user_id: 'u-1' });
  const other = createStore({ db });
  await other.init();
  let release;
  const gate = new Promise((res) => { release = res; });
  const f = fakeFetch(async () => { await gate; return jsonRes(200, NEW_BODY); });
  const p = getValidSession(store, f, { now: () => NOW, locks: null });
  while (f.calls.length === 0) await new Promise((res) => setTimeout(res, 1));
  const B = { ...OLD, access_token: 'b-access', refresh_token: 'b-refresh', user_id: 'u-2', email: 'b@x.com' };
  await other.resetForAccount('u-2', { meta: { session: B } });
  release();
  const r = await p;
  assert.equal((await loadSession(store)).user_id, 'u-2');
  assert.equal((await loadSession(store)).access_token, 'b-access');
  assert.equal(r.session, undefined);
});

test('刷新回「失效」、标失效前刚好被登出清掉 → 不把失效的 session 写回已清空的账本', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session: OLD, owner_user_id: 'u-1' });
  const other = createStore({ db });
  await other.init();
  const real = store.getMeta;
  let reads = 0;
  store.getMeta = async (k) => {
    const v = await real(k);
    if (k === 'session' && ++reads === 2) await other.wipeLocal(); // 第二次是标失效前的重读
    return v;
  };
  const orig = console.warn;
  console.warn = () => {};
  let r;
  try {
    r = await getValidSession(store, fakeFetch(() => jsonRes(400, { error_code: 'session_expired' })), { now: () => NOW, locks: null });
  } finally { console.warn = orig; store.getMeta = real; }
  assert.equal(reads, 2);
  assert.deepEqual(r, { invalid: true });
  assert.equal(await db.getMeta('session'), undefined);
});
