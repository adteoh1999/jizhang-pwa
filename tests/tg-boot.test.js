// 3b-9：Telegram 启动决策（纯函数）、runTgBoot、runTgCheck、replaceSessionIfSameUser
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgBootStep, tgAfterLogin, runTgBoot, runTgCheck, shouldRecheck, checkDue, TG_RECHECK_MS, TG_RETRY_CHECK_MS, TG_TEXT } from '../js/tg-boot.js';
import { readFileSync } from 'node:fs';
import { replaceSessionIfSameUser, loadSession, saveSession } from '../js/auth.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

const T0 = Date.parse('2026-11-26T10:00:00Z');
const ENV_TG = '987654321';
const OTHER_TG = '111222333';
const ses = (id, extra = {}) => ({ access_token: `at-${id}`, refresh_token: `rt-${id}`, expires_at: T0 + 3600e3, user_id: id, email: `${id}@x.invalid`, platform: 'pwa', ...extra });
const linked = (id) => ({ ok: true, status: 'linked', session: ses(id, { access_token: `new-${id}` }), label: '@zed' });
const UNLINKED = { ok: true, status: 'unlinked', label: '@zed', bindDeadline: T0 + 500_000 };

// ---------------- 纯函数：穷举（r1-S2） ----------------

const SESSIONS = { none: null, same: ses('u-A'), other: ses('u-B'), invalid: ses('u-A', { invalid: true }) };
const TGIDS = { none: null, same: ENV_TG, diff: OTHER_TG };

test('tgBootStep：session 在、没有 invalid、tgId 相同才 reuse', () => {
  for (const [sk, s] of Object.entries(SESSIONS)) {
    for (const [tk, t] of Object.entries(TGIDS)) {
      const want = s && !s.invalid && t === ENV_TG ? 'reuse' : 'login';
      assert.equal(tgBootStep({ session: s, tgId: t, envTgId: ENV_TG }), want, `${sk}/${tk}`);
    }
  }
});

test('tgAfterLogin：穷举 session × tgId × owned × 结果，检查四条不变量', () => {
  const results = { linkedA: linked('u-A'), linkedB: linked('u-B'), unlinked: UNLINKED };
  let n = 0;
  for (const [sk, s] of Object.entries(SESSIONS)) {
    for (const [tk, t] of Object.entries(TGIDS)) {
      for (const owned of [true, false]) {
        for (const [rk, result] of Object.entries(results)) {
          // 账本主人：有资料就是 u-A 的（owner 优先）；没资料时看 session
          const prevUser = owned ? 'u-A' : (s ? s.user_id : null);
          const local = { session: s, tgId: t, prevUser, owned };
          const r = tgAfterLogin({ local, envTgId: ENV_TG, result });
          const why = `${sk}/${tk}/${owned}/${rk} → ${r.do}`;
          const hasLocal = !!(s || owned);
          // ① tgId 不同、本机有资料、linked 账号 ≠ prevUser → foreign
          if (t !== ENV_TG && hasLocal && result.status === 'linked' && result.session.user_id !== prevUser) assert.equal(r.do, 'foreign', why);
          // ② exportOk 只在 tgId 相同
          assert.equal(r.exportOk, t === ENV_TG, why);
          // ④ unlinked 且本机有 session 或账本 → 只会是 foreign 或 gone
          if (result.status === 'unlinked' && hasLocal) assert.ok(['foreign', 'gone'].includes(r.do), why);
          if (result.status === 'unlinked' && !hasLocal) assert.equal(r.do, 'login', why);
          assert.ok(['adopt', 'fresh', 'foreign', 'switch', 'gone', 'login'].includes(r.do), why);
          n += 1;
        }
      }
    }
  }
  assert.equal(n, 4 * 3 * 2 * 3);
  // ③ invalid session 永远不 reuse（tgBootStep 那条已测）
});

test('tgAfterLogin：典型情况', () => {
  const L = (o) => ({ session: null, tgId: null, prevUser: null, owned: false, ...o });
  assert.equal(tgAfterLogin({ local: L({ session: ses('u-A'), tgId: ENV_TG, prevUser: 'u-A' }), envTgId: ENV_TG, result: linked('u-A') }).do, 'adopt');
  assert.equal(tgAfterLogin({ local: L({}), envTgId: ENV_TG, result: linked('u-A') }).do, 'fresh');
  assert.equal(tgAfterLogin({ local: L({ tgId: ENV_TG, prevUser: 'u-A', owned: true }), envTgId: ENV_TG, result: linked('u-B') }).do, 'switch');
  assert.equal(tgAfterLogin({ local: L({ tgId: OTHER_TG, prevUser: 'u-A', owned: true }), envTgId: ENV_TG, result: linked('u-B') }).do, 'foreign');
  assert.equal(tgAfterLogin({ local: L({ tgId: ENV_TG, prevUser: 'u-A', owned: true }), envTgId: ENV_TG, result: UNLINKED }).do, 'gone');
  assert.equal(tgAfterLogin({ local: L({}), envTgId: ENV_TG, result: UNLINKED }).do, 'login');
  for (const kind of ['invalid', 'limited', 'net', 'server']) {
    assert.equal(tgAfterLogin({ local: L({}), envTgId: ENV_TG, result: { ok: false, kind } }).do, kind);
  }
  assert.equal(tgAfterLogin({ local: L({}), envTgId: ENV_TG, result: { ok: true, status: 'stale' } }).do, 'stale');
});

test('checkDue：上次 ok／renewed → 30 分钟；skip（网络错等）→ 1 分钟后可以再试；从没检查 → 马上', () => {
  assert.equal(TG_RETRY_CHECK_MS, 60_000);
  assert.equal(checkDue({ lastAt: 0, lastResult: null }, T0), true);
  assert.equal(checkDue({ lastAt: T0, lastResult: 'ok' }, T0 + TG_RECHECK_MS - 1), false);
  assert.equal(checkDue({ lastAt: T0, lastResult: 'renewed' }, T0 + TG_RECHECK_MS), true);
  assert.equal(checkDue({ lastAt: T0, lastResult: 'skip' }, T0 + 59_999), false);
  assert.equal(checkDue({ lastAt: T0, lastResult: 'skip' }, T0 + 60_000), true);
});

test('shouldRecheck：最多 30 分钟一次', () => {
  assert.equal(TG_RECHECK_MS, 30 * 60_000);
  assert.equal(shouldRecheck(0, T0), true);
  assert.equal(shouldRecheck(T0, T0 + TG_RECHECK_MS - 1), false);
  assert.equal(shouldRecheck(T0, T0 + TG_RECHECK_MS), true);
});

// ---------------- runTgBoot ----------------

async function makeStore({ session = null, tgId = null, owner = null, last = null, txs = 0, db = createMemoryDb() } = {}) {
  const store = createStore({ db });
  await store.init();
  for (let i = 0; i < txs; i++) {
    await store.saveTransaction({ kind: 'expense', amountMinor: 1 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  }
  const meta = {};
  if (session) meta.session = session;
  if (tgId) meta.tgId = tgId;
  if (owner) meta.owner_user_id = owner;
  if (last) meta.lastUserId = last;
  if (Object.keys(meta).length) await store.setMetas(meta);
  return { store, db };
}

function bootDeps(store, { result = linked('u-A'), online = true, choice = async () => 'close', askReset = async () => true, wipeOk = true } = {}) {
  const log = { tgLogin: 0, logout: [], screens: [], shell: [], login: [], closed: 0, toasts: [], resets: 0, gone: 0, wipes: 0, choices: [], loading: 0 };
  const deps = {
    store,
    env: { mode: 'telegram', initData: 'INIT', tgId: ENV_TG, authDate: Math.floor(T0 / 1000), webApp: {} },
    online: () => online,
    tgLogin: async () => { log.tgLogin += 1; return result; },
    logoutServer: (s) => { log.logout.push(s.access_token); },
    choice: async (o) => { log.choices.push(o); return choice(o); },
    askReset: async (info) => askReset(info),
    wipe: async () => { log.wipes += 1; if (wipeOk) await store.wipeLocal(); return wipeOk; },
    showScreen: (o) => { log.screens.push(o); },
    showLoading: () => { log.loading += 1; },
    mountShell: (s) => { log.shell.push(s); },
    mountLogin: (r) => { log.login.push(r); },
    closeMiniApp: () => { log.closed += 1; },
    toast: (m) => { log.toasts.push(m); },
    announceReset: () => { log.resets += 1; },
    runTgGone: async () => { log.gone += 1; },
  };
  return { deps, log };
}

test('runTgBoot：reuse（session 有效、tgId 相同）→ 直接 mountShell，不叫 tgLogin', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: ENV_TG, owner: 'u-A' });
  const { deps, log } = bootDeps(store);
  assert.equal(await runTgBoot(deps), 'shell');
  assert.equal(log.tgLogin, 0);
  assert.equal(log.shell[0].user_id, 'u-A');
});

test('runTgBoot：离线 → 「需要网络」画面，不叫 tgLogin', async () => {
  const { store } = await makeStore();
  const { deps, log } = bootDeps(store, { online: false });
  assert.equal(await runTgBoot(deps), 'screen');
  assert.equal(log.tgLogin, 0);
  assert.equal(log.screens[0].title, TG_TEXT.netTitle);
});

test('runTgBoot：net／server／limited／invalid／stale → 对应的全屏画面', async () => {
  const cases = [
    [{ ok: false, kind: 'net' }, TG_TEXT.netTitle, TG_TEXT.retry],
    [{ ok: false, kind: 'server' }, TG_TEXT.serverTitle, TG_TEXT.retry],
    [{ ok: false, kind: 'limited' }, TG_TEXT.limitedTitle, TG_TEXT.retry],
    [{ ok: false, kind: 'invalid' }, TG_TEXT.invalidTitle, TG_TEXT.close],
    [{ ok: true, status: 'stale' }, TG_TEXT.invalidTitle, TG_TEXT.close],
  ];
  for (const [result, title, btn] of cases) {
    const { store } = await makeStore();
    const { deps, log } = bootDeps(store, { result });
    assert.equal(await runTgBoot(deps), 'screen');
    assert.equal(log.screens[0].title, title);
    assert.equal(log.screens[0].buttonLabel, btn);
  }
  assert.equal(TG_TEXT.invalidMessage, '请关掉后，从 @adjizhangbot 的选单按钮重新打开。');
});

test('runTgBoot：invalid 画面按「关闭」→ closeMiniApp', async () => {
  const { store } = await makeStore();
  const { deps, log } = bootDeps(store, { result: { ok: false, kind: 'invalid' } });
  await runTgBoot(deps);
  log.screens[0].onClick();
  assert.equal(log.closed, 1);
});

test('runTgBoot：adopt → 一次写 session、tgId、lastUserId；旧 session 有效就尽力作废；mountShell，没有 toast', async () => {
  const { store } = await makeStore({ session: ses('u-A', { expires_at: T0 - 1 }), tgId: OTHER_TG, owner: 'u-A' });
  const seen = [];
  const orig = store.setMetas.bind(store);
  store.setMetas = (m) => { seen.push(Object.keys(m).sort()); return orig(m); };
  const { deps, log } = bootDeps(store);
  assert.equal(await runTgBoot(deps), 'shell');
  assert.deepEqual(seen, [['lastUserId', 'session', 'tgId']]);
  assert.equal((await loadSession(store)).access_token, 'new-u-A');
  assert.equal(await store.getMeta('tgId'), ENV_TG);
  assert.deepEqual(log.logout, ['at-u-A']);
  assert.equal(log.shell[0].access_token, 'new-u-A');
  assert.equal(log.toasts.length, 0);
});

test('runTgBoot：fresh（本机空）→ 写三键、mountShell、toast「已用 Telegram 名字 登录 · 邮箱」（Review Focus 2）', async () => {
  const { store } = await makeStore();
  const { deps, log } = bootDeps(store);
  assert.equal(await runTgBoot(deps), 'shell');
  assert.equal(await store.getMeta('tgId'), ENV_TG);
  assert.equal(await store.getMeta('lastUserId'), 'u-A');
  assert.deepEqual(log.toasts, ['已用 Telegram @zed 登录 · u-A@x.invalid']);
});

test('runTgBoot：伪造身份＋没连接（本机空）→ 只会到登录页（之后要确认连接）', async () => {
  const { store } = await makeStore();
  const { deps, log } = bootDeps(store, { result: UNLINKED });
  assert.equal(await runTgBoot(deps), 'login');
  assert.deepEqual(log.login, [UNLINKED]);
  assert.equal(await loadSession(store), null);
});

test('runTgBoot：unlinked＋本机同 tgId 有账本 → runTgGone，没挂登录页（r2-M2-3）', async () => {
  const { store } = await makeStore({ tgId: ENV_TG, owner: 'u-A', txs: 1 });
  const { deps, log } = bootDeps(store, { result: UNLINKED });
  assert.equal(await runTgBoot(deps), 'gone');
  assert.equal(log.gone, 1);
  assert.equal(log.login.length, 0);
});

test('runTgBoot：switch（同 tgId、账本是 A、换成 B）有没上传 → askReset；同意 → resetForAccount＋announceReset', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: ENV_TG, owner: 'u-A', txs: 2 });
  await store.setMetas({ session: ses('u-A', { invalid: true }) });
  const asked = [];
  const { deps, log } = bootDeps(store, { result: linked('u-B'), askReset: async (i) => { asked.push(i); return true; } });
  assert.equal(await runTgBoot(deps), 'shell');
  assert.deepEqual(asked, [{ any: true, txCount: 2 }]);
  assert.equal(store.transactions().length, 0);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
  assert.equal(await store.getMeta('tgId'), ENV_TG);
  assert.equal(log.resets, 1);
});

test('runTgBoot：switch 取消 → 作废新 session、closeMiniApp、本机不动', async () => {
  const { store } = await makeStore({ session: ses('u-A', { invalid: true }), tgId: ENV_TG, owner: 'u-A', txs: 2 });
  const { deps, log } = bootDeps(store, { result: linked('u-B'), askReset: async () => false });
  assert.equal(await runTgBoot(deps), 'closed');
  assert.deepEqual(log.logout, ['new-u-B']);
  assert.equal(log.closed, 1);
  assert.equal(store.transactions().length, 2);
  assert.equal((await loadSession(store)).user_id, 'u-A');
  // close() 没作用（内建浏览器）时也不是白屏
  assert.equal(log.screens.length, 1);
  assert.equal(log.screens[0].title, TG_TEXT.closedTitle);
});

test('runTgBoot：foreign（别的 Telegram 的账本）→ 对话框不提供导出；按关闭 → 没写入、作废新 session、closeMiniApp', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: OTHER_TG, owner: 'u-A', txs: 2 });
  const { deps, log } = bootDeps(store, { result: linked('u-B'), choice: async () => 'close' });
  assert.equal(await runTgBoot(deps), 'closed');
  const c = log.choices[0];
  assert.equal(c.title, '这台设备上有另一个账号的账本');
  assert.equal(c.message, '继续会用 Telegram @zed 登录，并清除这本账（还没上传的记录会消失）。不认识这个名字就按「关闭」。');
  assert.deepEqual(c.buttons.map((b) => b.label), ['关闭', '清除并继续'], '安全选项在左');
  assert.equal(c.buttons[1].destructive, true);
  assert.equal(c.buttons[0].focus, true);
  assert.ok(!c.buttons.some((b) => /导出/.test(b.label)));
  assert.deepEqual(log.logout, ['new-u-B']);
  assert.equal(log.closed, 1);
  assert.equal((await loadSession(store)).user_id, 'u-A');
  assert.equal(store.transactions().length, 2);
  assert.equal(log.screens.length, 1);
  assert.equal(log.screens[0].title, TG_TEXT.closedTitle);
});

test('runTgBoot：foreign 按「清除并继续」→ wipe、announceReset、作废旧 session、写新 session、mountShell、toast', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: OTHER_TG, owner: 'u-A', txs: 2 });
  const { deps, log } = bootDeps(store, { result: linked('u-B'), choice: async () => 'clear' });
  assert.equal(await runTgBoot(deps), 'shell');
  assert.equal(log.wipes, 1);
  assert.equal(log.resets, 1);
  assert.deepEqual(log.logout, ['at-u-A']);
  assert.equal((await loadSession(store)).user_id, 'u-B');
  assert.equal(await store.getMeta('tgId'), ENV_TG);
  assert.equal(store.transactions().length, 0);
  assert.equal(log.toasts.length, 1);
});

test('runTgBoot：foreign＋没连接 → 按清除后到登录页；名字空 → 「这个 Telegram」', async () => {
  const { store } = await makeStore({ tgId: OTHER_TG, owner: 'u-A', txs: 1 });
  const { deps, log } = bootDeps(store, { result: { ...UNLINKED, label: '' }, choice: async () => 'clear' });
  assert.equal(await runTgBoot(deps), 'login');
  assert.equal(log.choices[0].message, TG_TEXT.foreignUnlinkedMessage);
  assert.equal(TG_TEXT.foreignUnlinkedMessage, '继续会清除这本账（还没上传的记录会消失），之后要用邮箱登录。不认识这本账就按「关闭」。');
  assert.equal(log.wipes, 1);
});

test('runTgBoot：foreign 清除失败 → 作废新 session、错误画面', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: OTHER_TG, owner: 'u-A', txs: 1 });
  const { deps, log } = bootDeps(store, { result: linked('u-B'), choice: async () => 'clear', wipeOk: false });
  assert.equal(await runTgBoot(deps), 'screen');
  assert.ok(log.logout.includes('new-u-B'));
  assert.equal(log.screens[0].title, TG_TEXT.notSavedTitle);
});

test('runTgBoot：写入失败 → 作废新 session、「登录资料没存好，请再试一次」', async () => {
  const { store, db } = await makeStore();
  const { deps, log } = bootDeps(store);
  db.failNextWrite(new Error('disk'));
  assert.equal(await runTgBoot(deps), 'screen');
  assert.deepEqual(log.logout, ['new-u-A']);
  assert.equal(log.screens[0].title, '登录资料没存好，请再试一次');
  assert.equal(log.shell.length, 0);
});

test('runTgBoot：tgLogin 超过 1 秒才回 → 先显示「正在载入…」；很快回就不显示', async () => {
  const { store } = await makeStore();
  const slow = bootDeps(store);
  slow.deps.loadingAfterMs = 30;
  slow.deps.tgLogin = () => new Promise((r) => setTimeout(() => r(linked('u-A')), 300));
  await runTgBoot(slow.deps);
  assert.equal(slow.log.loading, 1);
  const s2 = await makeStore();
  const fast = bootDeps(s2.store);
  fast.deps.loadingAfterMs = 300;
  fast.deps.tgLogin = () => new Promise((r) => setTimeout(() => r(linked('u-A')), 30));
  await runTgBoot(fast.deps);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fast.log.loading, 0);
});

// ---------------- runTgCheck ----------------

function checkDeps({ get = { session: ses('u-A') }, check = { ok: true, data: { linked: true } }, login = linked('u-A'), saved = true } = {}) {
  const log = { check: 0, login: 0, saved: [], discard: [] };
  return {
    log,
    deps: {
      env: { initData: 'INIT', tgId: ENV_TG },
      userId: 'u-A',
      getSession: async () => get,
      tgLink: async (token, action, opts) => { log.check += 1; assert.equal(action, 'check'); assert.equal(opts.initData, 'INIT'); return check; },
      tgLogin: async () => { log.login += 1; return login; },
      saveSession: async (s) => { log.saved.push(s); return saved; },
      discard: (s) => { log.discard.push(s.access_token); },
    },
  };
}

test('runTgCheck：check 连着 → ok；没连着 → gone', async () => {
  assert.equal(await runTgCheck(checkDeps().deps), 'ok');
  assert.equal(await runTgCheck(checkDeps({ check: { ok: true, data: { linked: false } } }).deps), 'gone');
});

test('runTgCheck：check 401 → 改问 tgLogin：unlinked → gone；同账号 → renewed（只存 session）；别账号 → gone 并作废', async () => {
  const c401 = { ok: false, status: 401, code: null, error: 'x', retry: false };
  assert.equal(await runTgCheck(checkDeps({ check: c401, login: UNLINKED }).deps), 'gone');
  const same = checkDeps({ check: c401 });
  assert.equal(await runTgCheck(same.deps), 'renewed');
  assert.equal(same.log.saved[0].access_token, 'new-u-A');
  const other = checkDeps({ check: c401, login: linked('u-B') });
  assert.equal(await runTgCheck(other.deps), 'gone');
  assert.deepEqual(other.log.discard, ['new-u-B']);
  assert.equal(other.log.saved.length, 0);
});

test('runTgCheck：session invalid → 不叫 check，直接问 tgLogin', async () => {
  const x = checkDeps({ get: { invalid: true } });
  assert.equal(await runTgCheck(x.deps), 'renewed');
  assert.equal(x.log.check, 0);
  assert.equal(x.log.login, 1);
});

test('runTgCheck：renewed 写回时本机已登出或换账号（saveSession 不是 true）→ 作废新 session、skip', async () => {
  for (const saved of [false, null]) {
    const x = checkDeps({ get: { invalid: true }, saved });
    assert.equal(await runTgCheck(x.deps), 'skip');
    assert.deepEqual(x.log.discard, ['new-u-A']);
  }
});

test('runTgCheck：init_stale、tg_invalid、网络错、拿 session retry、tgLogin stale／net → skip（不清本机）', async () => {
  const cases = [
    { check: { ok: false, status: 422, code: 'init_stale', error: '', retry: false } },
    { check: { ok: false, status: 403, code: 'tg_invalid', error: '', retry: false } },
    { check: { ok: false, status: 0, code: null, error: '需要网络', retry: true } },
    { get: { retry: true } },
    { get: { invalid: true }, login: { ok: true, status: 'stale' } },
    { get: { invalid: true }, login: { ok: false, kind: 'net' } },
    { get: { invalid: true }, login: { ok: false, kind: 'invalid' } },
    { check: { ok: true, data: {} } },
  ];
  for (const c of cases) assert.equal(await runTgCheck(checkDeps(c).deps), 'skip', JSON.stringify(c));
});

// ---------------- replaceSessionIfSameUser（auth.js） ----------------

test('replaceSessionIfSameUser：本机还是同一个账号 → 换掉 session、回 true；已登出或换账号 → 不写、回 false', async () => {
  const { store } = await makeStore({ session: ses('u-A', { invalid: true }) });
  assert.equal(await replaceSessionIfSameUser(store, ses('u-A', { access_token: 'NEW' }), 'u-A'), true);
  assert.equal((await loadSession(store)).access_token, 'NEW');

  const b = await makeStore({ session: ses('u-B') });
  assert.equal(await replaceSessionIfSameUser(b.store, ses('u-A', { access_token: 'NEW' }), 'u-A'), false);
  assert.equal((await loadSession(b.store)).user_id, 'u-B');

  const c = await makeStore();
  assert.equal(await replaceSessionIfSameUser(c.store, ses('u-A'), 'u-A'), false);
  assert.equal(await loadSession(c.store), null);
});

test('replaceSessionIfSameUser：新 session 不是这个账号 → false；写入失败 → false（不 reject）', async () => {
  const { store, db } = await makeStore({ session: ses('u-A') });
  assert.equal(await replaceSessionIfSameUser(store, ses('u-B'), 'u-A'), false);
  db.failNextWrite(new Error('disk'));
  assert.equal(await replaceSessionIfSameUser(store, ses('u-A', { access_token: 'NEW' }), 'u-A'), false);
  await saveSession(store, ses('u-A'));
});


test('runTgBoot：tgLogin 之后出意外（例如对话框丢错）→ 新 session 先作废再往外丢', async () => {
  const { store } = await makeStore({ session: ses('u-A'), tgId: OTHER_TG, owner: 'u-A', txs: 1 });
  const { deps, log } = bootDeps(store, { result: linked('u-B'), choice: async () => { throw new Error('boom'); } });
  await assert.rejects(runTgBoot(deps), /boom/);
  assert.ok(log.logout.includes('new-u-B'));
});

// app.js 不能在 node 执行：用原始码检查接线（审核建议）
test('app.js 接线：Telegram 进 App 都带 telegram；renewed 后叫同步；检查用 checkDue、online 也会触发；Telegram 不显示安装提示', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const boot = app.slice(app.indexOf('async function bootTelegram'), app.indexOf('async function boot()'));
  assert.match(boot, /mountShell: \(s\) => enterApp\(root, store, s, \{ telegram: tg \}\)/);
  assert.match(boot, /onSignedIn: \(s\) => enterApp\(root, store, s, \{ telegram: tg \}\)/);
  assert.match(app, /saveSession: \(s\) => replaceSessionIfSameUser\(store, s, session\.user_id\)/);
  assert.match(app, /if \(!telegram\) maybeShowInstallHint/);
  assert.match(app, /r === 'renewed'[^\n]*sync\.schedule\(\{ force: true \}\)/);
  assert.match(app, /checkDue\(/);
  assert.match(app, /addEventListener\('online'/);
  assert.match(app, /exportable: false/);
});
