// 2f Task 6：设置页「删除账号和全部数据」的流程（假对话框、假 fetch、记忆体资料库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { runDeleteAccount, DELETE_TEXT, dangerRows, busyRowHandler } from '../js/ui/delete-account.js';
import { wipeLocalLocked, getValidSession, withLock } from '../js/auth.js';
import { HIDE_KEY } from '../js/ui/home.js';
import { SUPABASE_URL } from '../js/config.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = Date.parse('2099-01-01T00:00:00Z');
const SESSION = { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: FAR, user_id: 'u-A', email: 'a@example.invalid', platform: 'pwa' };
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });

async function setup({ session = SESSION, deleteRes = () => res(200, { ok: true }), refreshRes, choice = 'continue', confirm = true, online = true, userId = 'u-A', locks } = {}) {
  let n = 0;
  const db = createMemoryDb();
  const store = createStore({ db, uuid: () => fakeUuid(++n) });
  await store.init();
  await store.setMetas({ session, owner_user_id: 'u-A', lastUserId: 'u-A' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 690, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  const log = [];
  const fetchCalls = [];
  const fetchFn = async (url, init) => {
    fetchCalls.push({ url, init });
    log.push(`fetch:${url.replace(SUPABASE_URL, '')}`);
    if (url.includes('/functions/v1/delete-account')) return deleteRes(url, init);
    if (url.includes('/auth/v1/token')) return refreshRes ? refreshRes() : res(500, {});
    throw new Error(`没有设定的网址：${url}`);
  };
  const dialogs = {
    choiceDialog: async (o) => { log.push(`choice:${o.title}`); dialogs.lastChoice = o; return choice; },
    confirmDialog: async (o) => { log.push(`confirm:${o.title}`); dialogs.lastConfirm = o; return confirm; },
    messageDialog: async (o) => { log.push(`message:${o.title}`); dialogs.lastMessage = o; },
  };
  const storage = { removeItem: (k) => log.push(`storage.remove:${k}`) };
  const deps = {
    store, fetchFn, dialogs, storage,
    sync: { stop: () => log.push('sync.stop') },
    realtime: { stop: () => log.push('realtime.stop') },
    isOnline: () => online,
    reload: () => log.push('reload'),
    announce: () => log.push('announce'),
    onBusy: (b) => log.push(`busy:${b}`),
    block: () => { log.push('block'); return () => log.push('unblock'); },
    exportCsv: () => log.push('export'),
    userId,
    deleteTimeoutMs: 30,
    ...(locks ? { locks } : {}),
  };
  return { db, store, log, fetchCalls, dialogs, deps };
}
const ran = (log, prefix) => log.some((l) => l.startsWith(prefix));
// 失败路径都要复位（审核 4）：busy:false、放开画面
const assertReset = (log) => {
  assert.ok(log.includes('busy:false'), '要 busy:false');
  assert.ok(log.includes('unblock'), '要放开画面');
};
const hangUntilAbort = (init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
const REFRESHED = { access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 3600, user: { id: 'u-A', email: 'a@example.invalid' } };

test('离线：只显示「需要网络」，没叫服务器、没停同步', async () => {
  const { log, deps } = await setup({ online: false });
  assert.equal(await runDeleteAccount(deps), 'cancel');
  assert.deepEqual(log, [`message:${DELETE_TEXT.offlineTitle}`]);
});

test('第一步：标题、内文、三个按钮（先导出 CSV 不关窗／继续删除红字／取消有焦点）', async () => {
  const { dialogs, deps } = await setup({ choice: null });
  await runDeleteAccount(deps);
  const o = dialogs.lastChoice;
  assert.equal(o.title, '删除账号和全部数据？');
  assert.equal(o.message, '会永久删除你在这台设备和云端的所有记录、分类和设置，无法复原。');
  assert.deepEqual(o.buttons.map((b) => b.label), ['先导出 CSV', '继续删除', '取消']);
  assert.equal(o.buttons[0].keepOpen, true);
  assert.equal(o.buttons[1].destructive, true);
  assert.ok(!o.buttons[1].bold, '破坏性按钮不设为默认');
  assert.equal(o.buttons[2].focus, true);
});

test('第一步按「先导出 CSV」会叫导出', async () => {
  const { log, dialogs, deps } = await setup({ choice: null });
  await runDeleteAccount(deps);
  dialogs.lastChoice.buttons[0].onClick();
  assert.ok(log.includes('export'));
});

test('第一步取消 → cancel，没停同步、没叫服务器、没有第二步', async () => {
  const { log, deps } = await setup({ choice: null });
  assert.equal(await runDeleteAccount(deps), 'cancel');
  assert.ok(!ran(log, 'sync.stop') && !ran(log, 'fetch:') && !ran(log, 'confirm:'));
});

test('第二步：要输入「删除」、按钮「永久删除」红字；取消 → cancel、什么都没动', async () => {
  const { store, log, dialogs, deps } = await setup({ confirm: false });
  assert.equal(await runDeleteAccount(deps), 'cancel');
  const o = dialogs.lastConfirm;
  assert.equal(o.title, '确定永久删除？');
  assert.equal(o.message, '请输入「删除」以确认。');
  assert.equal(o.requireText, '删除');
  assert.equal(o.confirmLabel, '永久删除');
  assert.equal(o.destructive, true);
  assert.ok(!ran(log, 'sync.stop') && !ran(log, 'fetch:'));
  assert.equal(store.transactions().length, 1);
});

test('成功：正在删除（挡住画面）→ 拿 session → 停同步与 Realtime → 叫 delete-account → 清本机 → 清隐藏金额 → 广播 → 放开 → 告知 → 重新整理', async () => {
  const { db, store, log, fetchCalls, deps } = await setup();
  assert.equal(await runDeleteAccount(deps), 'done');
  const steps = log.filter((l) => !l.startsWith('choice:') && !l.startsWith('confirm:'));
  assert.deepEqual(steps, [
    'busy:true', 'block', 'sync.stop', 'realtime.stop', 'fetch:/functions/v1/delete-account',
    `storage.remove:${HIDE_KEY}`, 'announce', 'unblock', `message:${DELETE_TEXT.doneTitle}`, 'reload',
  ]);
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer tok-A');
  assert.equal(store.transactions().length, 0);
  assert.equal((await db.getAll('transactions')).length, 0);
  assert.equal(await store.getMeta('session'), undefined);
  assert.equal(await store.getMeta('lastUserId'), undefined);
});

test('服务器失败：不清本机、显示服务器的中文、重新整理（让同步重新开始）', async () => {
  const { store, log, dialogs, deps } = await setup({ deleteRes: () => res(500, { error: '暂时无法删除，请稍后再试' }) });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '没能删除账号');
  assert.equal(dialogs.lastMessage.message, '暂时无法删除，请稍后再试');
  assert.equal(store.transactions().length, 1);
  assert.deepEqual(await store.getMeta('session'), SESSION);
  assert.ok(!ran(log, 'storage.remove') && !ran(log, 'announce'));
  assert.equal(log.at(-1), 'reload');
  assert.ok(log.includes('busy:false'));
  assert.ok(log.indexOf('unblock') < log.indexOf(`message:${DELETE_TEXT.failTitle}`), '结果对话框出现前放开');
});

test('登录已失效：不叫 delete-account、不停同步、提示重新登录（说明去哪里登录）、复位', async () => {
  const { log, dialogs, deps } = await setup({ session: { ...SESSION, invalid: true } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '请重新登录后再试');
  assert.equal(dialogs.lastMessage.message, '登录已过期。请先在上面「同步」那一列重新登录，再删除账号。');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop'));
  assertReset(log);
  // 复审小事：重新整理后同步那一列才一定会出现「重新登录」
  assert.equal(log.at(-1), 'reload');
});

test('token 要刷新但连不上：不叫 delete-account、提示稍后再试', async () => {
  const { log, dialogs, deps } = await setup({ session: { ...SESSION, expires_at: Date.now() - 1000 } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '暂时连不上');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop'));
  assertReset(log);
  // 审核 4：按下后立刻有回馈——busy 与挡画面在去刷新 token 之前
  const refresh = log.findIndex((l) => l.startsWith('fetch:/auth/v1/token'));
  assert.ok(refresh > 0, '有去刷新');
  assert.ok(log.indexOf('busy:true') < refresh);
  assert.ok(log.indexOf('block') < refresh);
});

test('连按两次只跑一次', async () => {
  const { log, deps } = await setup();
  const [a, b] = await Promise.all([runDeleteAccount(deps), runDeleteAccount(deps)]);
  assert.deepEqual([a, b].sort(), ['cancel', 'done']);
  assert.equal(log.filter((l) => l.startsWith('choice:')).length, 1);
  assert.equal(log.filter((l) => l.startsWith('fetch:/functions')).length, 1);
});

test('M6：本机清除失败一次 → 再试一次成功，照常完成', async () => {
  const { db, store, deps } = await setup();
  const write = db.write.bind(db);
  let fails = 1;
  db.write = async (c) => { if (c.clearMeta && fails-- > 0) throw new Error('disk'); return write(c); };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(store.transactions().length, 0);
  assert.equal(await store.getMeta('session'), undefined);
});

test('M6：服务器已删、本机两次都清不掉、清 session 成功 → 说明下次登录时会清、仍回 done', async () => {
  const { db, store, log, dialogs, deps } = await setup();
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) throw new Error('disk'); return write(c); };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(await store.getMeta('session'), null);
  assert.equal(dialogs.lastMessage.title, '账号已删除');
  assert.equal(dialogs.lastMessage.message, '这台设备上的资料还没清掉，下次登录时会清除。');
  assert.ok(!ran(log, 'announce'));
  assert.equal(log.at(-1), 'reload');
});

test('M6：本机清不掉、连 session 也清不掉 → 说明要重新整理再登出、仍回 done', async () => {
  const { db, store, log, dialogs, deps } = await setup();
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta || (c.meta && 'session' in c.meta)) throw new Error('disk'); return write(c); };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.deepEqual(await store.getMeta('session'), SESSION);
  assert.equal(dialogs.lastMessage.title, '账号已删除');
  assert.equal(dialogs.lastMessage.message, '但这台设备的资料没清掉，请重新整理后再登出一次。');
  assert.equal(log.at(-1), 'reload');
});

test('M6／审核 2：清 session 也走 jizhang-auth 锁（forgetSession）', async () => {
  const locks = fakeLocks();
  const { db, deps } = await setup({ locks });
  const write = db.write.bind(db);
  db.write = async (c) => {
    if (c.clearMeta) throw new Error('disk');
    if (c.meta && 'session' in c.meta) locks.log.push('write:session');
    return write(c);
  };
  assert.equal(await runDeleteAccount(deps), 'done');
  const i = locks.log.indexOf('write:session');
  assert.ok(i > 0, '有清 session');
  assert.equal(locks.log[i - 1], 'lock:jizhang-auth:enter');
  assert.equal(locks.log[i + 1], 'lock:jizhang-auth:exit');
});

test('M2：清除要等正在进行的 token 刷新做完（同一把锁），清完 session 仍是空的', async () => {
  const { store } = await setup({ session: { ...SESSION, expires_at: Date.now() - 1000 } });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchFn = async () => {
    await gate;
    return res(200, { access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 3600, user: { id: 'u-A', email: 'a@example.invalid' } });
  };
  const refreshing = getValidSession(store, fetchFn);
  await new Promise((r) => setTimeout(r, 10)); // 让刷新先拿到锁
  const wiping = wipeLocalLocked(store);
  release();
  await refreshing;
  assert.equal(await wiping, true);
  assert.equal(await store.getMeta('session'), undefined);
});

test('wipeLocalLocked：清除失败回 false（不 reject）', async () => {
  const { db, store } = await setup();
  db.failNextWrite(new Error('disk'));
  assert.equal(await wipeLocalLocked(store), false);
});

// 假的 navigator.locks：同名排队；支援 {signal}（等待中被中止 → AbortError、离开队伍）。log 记进出锁
function fakeLocks(log = []) {
  const queues = new Map();
  const pump = (name) => {
    const q = queues.get(name);
    if (!q || q.busy || q.waiting.length === 0) return;
    const w = q.waiting.shift();
    q.busy = true;
    log.push(`lock:${name}:enter`);
    Promise.resolve().then(w.cb).then(w.resolve, w.reject).finally(() => {
      log.push(`lock:${name}:exit`);
      q.busy = false;
      pump(name);
    });
  };
  return {
    log,
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      if (!queues.has(name)) queues.set(name, { busy: false, waiting: [] });
      return new Promise((resolve, reject) => {
        const w = { cb, resolve, reject };
        const q = queues.get(name);
        if (opts.signal) {
          if (opts.signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
          opts.signal.addEventListener('abort', () => {
            const i = q.waiting.indexOf(w);
            if (i !== -1) { q.waiting.splice(i, 1); reject(new DOMException('aborted', 'AbortError')); }
          });
        }
        q.waiting.push(w);
        pump(name);
      });
    },
  };
}
const holdLock = (locks, name = 'jizhang-auth') => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const held = locks ? locks.request(name, () => gate) : withLock(name, () => gate, null);
  return { release: () => { release(); return held; } };
};

test('2f-2 审核 5：jizhang-auth 锁被别人一直拿着 → 等到时限就不用锁直接清（Web Locks）', async () => {
  const { store } = await setup();
  const locks = fakeLocks();
  const h = holdLock(locks);
  const t0 = Date.now();
  assert.equal(await wipeLocalLocked(store, { locks, waitMs: 30 }), true);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(store.transactions().length, 0);
  assert.equal(await store.getMeta('session'), undefined);
  await h.release();
});

test('2f-2 审核 5：分页内后备锁也有时限；超时那次之后不会再补清一次，排队照旧', async () => {
  const { db, store } = await setup();
  let wipes = 0;
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) wipes++; return write(c); };
  const h = holdLock(null);
  assert.equal(await wipeLocalLocked(store, { locks: null, waitMs: 30 }), true);
  assert.equal(wipes, 1);
  // 拿着锁的人放手后：后面排队的要等它（不是等超时那个），而超时那个不会再跑
  let after = false;
  const next = withLock('jizhang-auth', async () => { after = true; }, null);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(after, false, '锁还被拿着，后面的人要等');
  await h.release();
  await next;
  assert.equal(after, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wipes, 1, '超时的那次不会在拿到锁后再清一次');
});

test('2f-2 审核 5：Web Locks 不支援 signal（等很久才给锁）也只清一次', async () => {
  const { db, store } = await setup();
  let wipes = 0;
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) wipes++; return write(c); };
  const base = fakeLocks();
  const noSignal = { request: (name, opts, cb) => base.request(name, typeof opts === 'function' ? opts : cb) };
  const h = holdLock(base);
  assert.equal(await wipeLocalLocked(store, { locks: noSignal, waitMs: 30 }), true);
  await h.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wipes, 1);
});

test('2f-2 审核 5：wipeLocalLocked 默认最多等锁 5 秒', async () => {
  const { store } = await setup();
  const orig = globalThis.setTimeout;
  const seen = [];
  globalThis.setTimeout = (cb, ms, ...a) => { seen.push(ms); return orig(cb, ms, ...a); };
  try { await wipeLocalLocked(store, { locks: fakeLocks() }); } finally { globalThis.setTimeout = orig; }
  assert.ok(seen.includes(5000), `看到的计时：${seen.join(',')}`);
});

test('审核 1：拿到的 session 已换成别的账号 → 不停同步、不叫服务器，提示账号已更换', async () => {
  const { store, log, dialogs, deps } = await setup({ session: { ...SESSION, user_id: 'u-B' } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop') && !ran(log, 'realtime.stop'));
  assert.equal(dialogs.lastMessage.title, '账号已更换');
  assert.equal(dialogs.lastMessage.message, '请重新整理后再试。');
  assert.equal(store.transactions().length, 1);
  assertReset(log);
  assert.equal(log.at(-1), 'reload', '复核小事：主屏幕 App 没有重新整理按钮，替用户重新整理');
});

test('审核 1：没传 userId 一律不删（防设置页漏传）', async () => {
  const { log, deps } = await setup({ userId: null });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop'));
});

test('审核 3：第一次超时、自动再叫一次成功 → done', async () => {
  let n = 0;
  const { store, log, deps } = await setup({ deleteRes: (url, init) => (++n === 1 ? hangUntilAbort(init) : res(200, { ok: true })) });
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(log.filter((l) => l === 'fetch:/functions/v1/delete-account').length, 2);
  assert.equal(store.transactions().length, 0);
});

test('审核 3：两次都超时 → 说明账号可能已经删除、请重新整理再试', async () => {
  const { store, log, dialogs, deps } = await setup({ deleteRes: (url, init) => hangUntilAbort(init) });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(log.filter((l) => l === 'fetch:/functions/v1/delete-account').length, 2);
  assert.equal(dialogs.lastMessage.message, '没收到服务器的回应，账号可能已经删除，请重新整理后再试一次。');
  assert.equal(store.transactions().length, 1);
  assert.equal(log.at(-1), 'reload');
  assertReset(log);
});

test('审核 3：断网（不是超时）→ 只叫一次、照旧「需要网络」', async () => {
  const { log, dialogs, deps } = await setup({ deleteRes: () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(log.filter((l) => l === 'fetch:/functions/v1/delete-account').length, 1);
  assert.equal(dialogs.lastMessage.title, '没能删除账号');
  assert.equal(dialogs.lastMessage.message, '需要网络');
});

test('审核 8：服务器回 401 → 用 failedToken 刷新、拿新 token 再叫一次 → done', async () => {
  let n = 0;
  const { log, fetchCalls, deps } = await setup({
    deleteRes: () => (++n === 1 ? res(401, { error: '请重新登录后再试' }) : res(200, { ok: true })),
    refreshRes: () => res(200, REFRESHED),
  });
  assert.equal(await runDeleteAccount(deps), 'done');
  const dels = fetchCalls.filter((c) => c.url.includes('/functions/v1/delete-account'));
  assert.deepEqual(dels.map((c) => c.init.headers.Authorization), ['Bearer tok-A', 'Bearer tok-new']);
  assert.ok(ran(log, 'fetch:/auth/v1/token'));
});

test('审核 8：两次都 401 → 提示重新登录', async () => {
  const { dialogs, deps } = await setup({
    deleteRes: () => res(401, { error: '请重新登录后再试' }),
    refreshRes: () => res(200, REFRESHED),
  });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '请重新登录后再试');
});

test('审核 8：401 后刷新失败（refresh token 失效）→ 提示重新登录、不再叫服务器', async () => {
  const { log, dialogs, deps } = await setup({
    deleteRes: () => res(401, { error: '请重新登录后再试' }),
    refreshRes: () => res(400, { error_code: 'refresh_token_not_found' }),
  });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(log.filter((l) => l === 'fetch:/functions/v1/delete-account').length, 1);
  assert.equal(dialogs.lastMessage.title, '请重新登录后再试');
});

test('复审 1：jizhang-auth 锁被别的分页卡住 → 拿 session 最多等时限，显示暂时连不上、复位、不叫服务器', async () => {
  const locks = fakeLocks();
  const h = holdLock(locks);
  const { log, dialogs, deps } = await setup({ locks });
  deps.lockWaitMs = 30;
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '暂时连不上');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop'));
  assertReset(log);
  await h.release();
});

test('复审 1：getValidSession 支援 waitMs（等不到锁 → retry，不会 reject）', async () => {
  const { store } = await setup();
  const locks = fakeLocks();
  const h = holdLock(locks);
  assert.deepEqual(await getValidSession(store, async () => res(500, {}), { locks, waitMs: 30 }), { retry: true });
  await h.release();
});

test('复审 1：删号流程拿 session 默认等锁 5 秒', () => {
  const src = readFileSync(new URL('../js/ui/delete-account.js', import.meta.url), 'utf8');
  assert.match(src, /lockWaitMs = LOCK_WAIT_MS/);
  assert.equal((src.match(/getValidSession\(store, fetchFn, \{[^}]*waitMs: lockWaitMs/g) || []).length, 2);
});

test('复审 2：401 后刷新连不上 → 「暂时连不上」（不是重新登录）、重新整理', async () => {
  const { log, dialogs, deps } = await setup({
    deleteRes: () => res(401, { error: '请重新登录后再试' }),
    refreshRes: () => res(503, {}),
  });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '暂时连不上');
  assert.equal(log.at(-1), 'reload');
});

test('复审 2：401 时别的分页已换成 B 登录 → 「账号已更换」、不再叫服务器', async () => {
  let st = null;
  const { store, log, dialogs, deps } = await setup({
    deleteRes: async () => {
      await st.setMeta('session', { ...SESSION, access_token: 'tok-B', user_id: 'u-B', email: 'b@example.invalid' });
      return res(401, { error: '请重新登录后再试' });
    },
  });
  st = store;
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(log.filter((l) => l === 'fetch:/functions/v1/delete-account').length, 1);
  assert.equal(dialogs.lastMessage.title, '账号已更换');
  assert.equal(log.at(-1), 'reload');
});

test('复审测试缺口：第一次超时、第二次 401、刷新后成功 → done（新 token）', async () => {
  let n = 0;
  const { fetchCalls, deps } = await setup({
    deleteRes: (url, init) => { n++; return n === 1 ? hangUntilAbort(init) : n === 2 ? res(401, {}) : res(200, { ok: true }); },
    refreshRes: () => res(200, REFRESHED),
  });
  assert.equal(await runDeleteAccount(deps), 'done');
  const dels = fetchCalls.filter((c) => c.url.includes('/functions/v1/delete-account'));
  assert.deepEqual(dels.map((c) => c.init.headers.Authorization), ['Bearer tok-A', 'Bearer tok-A', 'Bearer tok-new']);
});

test('复审 5：清除失败、锁被卡住 → 不用锁直接清 session，仍显示「下次登录时会清除」', async () => {
  const locks = fakeLocks();
  const { db, store, dialogs, deps } = await setup({ locks });
  deps.lockWaitMs = 30;
  const write = db.write.bind(db);
  let h = null;
  db.write = async (c) => {
    if (c.clearMeta) {
      if (!h) h = holdLock(locks); // 第一次清除失败后，别的分页拿住锁不放
      throw new Error('disk');
    }
    return write(c);
  };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(await store.getMeta('session'), null);
  assert.equal(dialogs.lastMessage.message, '这台设备上的资料还没清掉，下次登录时会清除。');
  await h.release();
});

test('复审测试缺口：withLock 带 waitMs 正常拿到锁 → fn 只跑一次、结果与错误原样传回（Web Locks 与后备锁）', async () => {
  for (const locks of [fakeLocks(), null]) {
    let runs = 0;
    assert.equal(await withLock('t-lock', async () => { runs++; return 42; }, locks, { waitMs: 1000 }), 42);
    assert.equal(runs, 1);
    await assert.rejects(withLock('t-lock', async () => { throw new TypeError('boom'); }, locks, { waitMs: 1000 }), (e) => e.name === 'TypeError');
    assert.equal(await withLock('t-lock', async () => 'ok', locks, { waitMs: 1000 }), 'ok', '出错后锁有放开');
  }
});

test('复审 3：「正在删除…」遮罩关闭时把焦点还给打开前的元素（还在文件里才还）', () => {
  const src = readFileSync(new URL('../js/ui/dialogs.js', import.meta.url), 'utf8');
  const i = src.indexOf('export function busyOverlay(');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /const opener = document\.activeElement;/);
  const close = body.slice(body.indexOf('return () =>'));
  assert.ok(close.indexOf('handle.close()') >= 0 && close.indexOf('handle.close()') < close.indexOf('opener.focus('), '先解除 inert 再还焦点');
  assert.match(close, /document\.contains\(opener\)/);
});

test('复核建议 1：外层 catch 也要复位——挡画面本身出错', async () => {
  const { log, deps } = await setup();
  deps.block = () => { throw new Error('boom'); };
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.ok(log.includes('busy:false'));
  assert.equal(log.at(-1), 'reload');
  assert.ok(!ran(log, 'fetch:'), '没往下走');
});

test('复核建议 1：外层 catch 也要复位——删成功后告知的对话框出错（这时列还是忙碌）', async () => {
  const { log, deps } = await setup();
  deps.dialogs.messageDialog = async () => { throw new Error('boom'); };
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.ok(log.includes('busy:false'));
  assert.equal(log.at(-1), 'reload');
});

test('复核小事：清本机等锁也用 lockWaitMs（全流程一个时限）', async () => {
  const locks = fakeLocks();
  let h = null;
  const { store, deps } = await setup({ locks, deleteRes: () => { h = holdLock(locks); return res(200, { ok: true }); } });
  deps.lockWaitMs = 30;
  const t0 = Date.now();
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.ok(Date.now() - t0 < 1000, `等太久：${Date.now() - t0}ms`);
  assert.equal(store.transactions().length, 0);
  await h.release();
});

test('审核 7：清本机发生在 jizhang-auth 锁里面', async () => {
  const locks = fakeLocks();
  const { db, deps } = await setup({ locks });
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) locks.log.push('wipe'); return write(c); };
  assert.equal(await runDeleteAccount(deps), 'done');
  const i = locks.log.indexOf('wipe');
  assert.ok(i > 0, '有清除');
  assert.equal(locks.log[i - 1], 'lock:jizhang-auth:enter');
  assert.equal(locks.log[i + 1], 'lock:jizhang-auth:exit');
});

test('复审小事：服务器已删、本机已清，通知其他分页出错 → 照常「账号已删除」、回 done', async () => {
  const { log, dialogs, deps } = await setup();
  deps.announce = () => { throw new Error('boom'); };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(dialogs.lastMessage.title, '账号已删除');
  assert.equal(dialogs.lastMessage.message, '你的账号和全部数据都已删除。');
  assert.equal(log.at(-1), 'reload');
});

test('小事：流程中途出错 → 复位、重新整理、回 fail（不会卡在「正在删除…」）', async () => {
  const { log, deps } = await setup();
  deps.sync = { stop: () => log.push('sync.stop') };
  deps.dialogs.messageDialog = async () => { throw new Error('boom'); }; // 结果对话框出错
  deps.fetchFn = async () => { throw new TypeError('x'); };
  assert.equal(await runDeleteAccount(deps), 'fail');
  assertReset(log);
  assert.equal(log.at(-1), 'reload');
  const b = await setup();
  b.deps.dialogs.confirmDialog = async () => { throw new Error('boom'); };
  assert.equal(await runDeleteAccount(b.deps), 'fail');
  assert.equal(b.log.at(-1), 'reload');
  assert.ok(!ran(b.log, 'unblock'), '还没挡画面就不用放开');
});

test('审核 9／方案 B：删除那一列忙碌时用 aria-disabled（不用 disabled）、改文字；结束复原（朗读交给遮罩，不另外念）', () => {
  const attrs = {};
  const btn = { disabled: false, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } };
  const label = { textContent: '删除账号和全部数据' };
  const onBusy = busyRowHandler({ btn, label, idleText: '删除账号和全部数据' });
  onBusy(true);
  assert.equal(label.textContent, '正在删除…');
  assert.equal(attrs['aria-disabled'], 'true');
  assert.equal(btn.disabled, false);
  onBusy(false);
  assert.equal(label.textContent, '删除账号和全部数据');
  assert.equal(attrs['aria-disabled'], undefined);
  const src = readFileSync(new URL('../js/ui/delete-account.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("from './announce.js'"), '不再另外用 announce 念（免得念两次）');
});

test('审核 4／方案 B：「正在删除…」遮罩——入栈（底下画面 inert）、Esc 关不掉、没有按钮；读屏看得到、焦点移过去', () => {
  const src = readFileSync(new URL('../js/ui/dialogs.js', import.meta.url), 'utf8');
  const i = src.indexOf('export function busyOverlay(');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(body, /pushLayer\(\{[^}]*onDismiss: \(\) => \{\}/);
  assert.ok(!body.includes('alertButton') && !body.includes("'button'"), '没有按钮');
  // 面板：读屏可读的对话框，名称就是那句话、可以拿焦点；里面的字 aria-hidden（免得念两次）
  const panel = body.slice(body.indexOf('const panel'), body.indexOf('const overlay'));
  assert.match(panel, /role: 'dialog'/);
  assert.match(panel, /'aria-modal': 'true'/);
  assert.match(panel, /'aria-label': text/);
  // 复核 r3（用户选 a）：那句字本身读屏可读、可聚焦，焦点放在它上面（一定念得到、摸得到）
  assert.match(body, /const msg = h\('p', \{ class: 'alert-title', tabindex: '-1' \}, text\);/);
  assert.ok(!body.includes("'aria-hidden'"), '面板、字、遮罩都不能 aria-hidden');
  // 入栈、放进画面之后把焦点移到那句字
  assert.ok(body.indexOf('document.body.append(overlay)') < body.indexOf('msg.focus('));
  assert.ok(!body.includes('panel.focus('));
  // 不能操作的元素被程序聚焦：不画焦点框
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.alert-busy \.alert-title:focus,\s*\.alert-busy \.alert-title:focus-visible \{ outline: none; \}/);
  const flow = readFileSync(new URL('../js/ui/delete-account.js', import.meta.url), 'utf8');
  assert.match(flow, /block = \(\) => busyOverlay\(T\.busyLabel\)/);
});

test('设置页：有登录才有「删除账号和全部数据」这一列', () => {
  assert.deepEqual(dangerRows(null), []);
  assert.deepEqual(dangerRows(SESSION), [{ kind: 'delete-account', label: '删除账号和全部数据' }]);
});

test('设置页挂上删除那一区（红字按钮、放在最下面、传挂载时的账号、忙碌用 busyRowHandler）', () => {
  const src = readFileSync(new URL('../js/ui/settings.js', import.meta.url), 'utf8');
  assert.match(src, /dangerRows\(session\)/);
  assert.match(src, /runDeleteAccount\(/);
  const about = src.indexOf("section('关于'");
  const danger = src.indexOf('...[dangerSection()]');
  assert.ok(about >= 0 && danger >= 0, '两段都要找得到');
  assert.ok(about < danger, '删除区要在「关于」之后');
  const sec = src.slice(src.indexOf('const dangerSection = () =>'), src.indexOf("return rows.length ? section('', rows) : null;"));
  assert.match(sec, /class: 'inset-row is-destructive'/);
  assert.match(sec, /userId: session\.user_id/);
  assert.match(sec, /onBusy: busyRowHandler\(/);
});
