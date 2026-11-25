// 2f Task 6：设置页「删除账号和全部数据」的流程（假对话框、假 fetch、记忆体资料库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { runDeleteAccount, DELETE_TEXT, dangerRows } from '../js/ui/delete-account.js';
import { wipeLocalLocked, getValidSession } from '../js/auth.js';
import { HIDE_KEY } from '../js/ui/home.js';
import { SUPABASE_URL } from '../js/config.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = Date.parse('2099-01-01T00:00:00Z');
const SESSION = { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: FAR, user_id: 'u-A', email: 'a@example.invalid', platform: 'pwa' };
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });

async function setup({ session = SESSION, deleteRes = () => res(200, { ok: true }), refreshRes, choice = 'continue', confirm = true, online = true } = {}) {
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
    if (url.includes('/functions/v1/delete-account')) return deleteRes();
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
    exportCsv: () => log.push('export'),
  };
  return { db, store, log, fetchCalls, dialogs, deps };
}
const ran = (log, prefix) => log.some((l) => l.startsWith(prefix));

test('离线：只显示「需要网络」，没叫服务器、没停同步', async () => {
  const { log, deps } = await setup({ online: false });
  assert.equal(await runDeleteAccount(deps), 'cancel');
  assert.deepEqual(log, [`message:${DELETE_TEXT.offlineTitle}`]);
});

test('第一步：标题、内文、三个按钮（先导出 CSV 不关窗／继续红字／取消有焦点）', async () => {
  const { dialogs, deps } = await setup({ choice: null });
  await runDeleteAccount(deps);
  const o = dialogs.lastChoice;
  assert.equal(o.title, '删除账号和全部数据？');
  assert.equal(o.message, '会永久删除你在这台设备和云端的所有账单、分类和设置，无法复原。');
  assert.deepEqual(o.buttons.map((b) => b.label), ['先导出 CSV', '继续', '取消']);
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

test('成功：先拿 session → 停同步与 Realtime → 正在删除 → 叫 delete-account → 清本机 → 清隐藏金额 → 广播 → 告知 → 重新整理', async () => {
  const { db, store, log, fetchCalls, deps } = await setup();
  assert.equal(await runDeleteAccount(deps), 'done');
  const steps = log.filter((l) => !l.startsWith('choice:') && !l.startsWith('confirm:'));
  assert.deepEqual(steps, [
    'sync.stop', 'realtime.stop', 'busy:true', 'fetch:/functions/v1/delete-account',
    `storage.remove:${HIDE_KEY}`, 'announce', `message:${DELETE_TEXT.doneTitle}`, 'reload',
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
});

test('登录已失效：不叫 delete-account、不停同步、提示重新登录', async () => {
  const { log, dialogs, deps } = await setup({ session: { ...SESSION, invalid: true } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '请重新登录后再试');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop') && !ran(log, 'reload'));
});

test('token 要刷新但连不上：不叫 delete-account、提示稍后再试', async () => {
  const { log, dialogs, deps } = await setup({ session: { ...SESSION, expires_at: Date.now() - 1000 } });
  assert.equal(await runDeleteAccount(deps), 'fail');
  assert.equal(dialogs.lastMessage.title, '暂时连不上');
  assert.ok(!ran(log, 'fetch:/functions') && !ran(log, 'sync.stop'));
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

test('M6：服务器已删、本机两次都清不掉 → 至少清 session、说明要重新整理再登出、仍回 done', async () => {
  const { db, store, log, dialogs, deps } = await setup();
  const write = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) throw new Error('disk'); return write(c); };
  assert.equal(await runDeleteAccount(deps), 'done');
  assert.equal(await store.getMeta('session'), null);
  assert.equal(dialogs.lastMessage.title, '账号已删除');
  assert.equal(dialogs.lastMessage.message, '但这台设备的资料没清掉，请重新整理后再登出一次。');
  assert.ok(!ran(log, 'announce'));
  assert.equal(log.at(-1), 'reload');
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

test('设置页：有登录才有「删除账号和全部数据」这一列', () => {
  assert.deepEqual(dangerRows(null), []);
  assert.deepEqual(dangerRows(SESSION), [{ kind: 'delete-account', label: '删除账号和全部数据' }]);
});

test('设置页挂上删除那一区（红字按钮、放在最下面）', () => {
  const src = readFileSync(new URL('../js/ui/settings.js', import.meta.url), 'utf8');
  assert.match(src, /dangerRows\(session\)/);
  assert.match(src, /runDeleteAccount\(/);
  const order = src.indexOf("section('关于'") < src.indexOf('dangerSection()');
  assert.ok(order, '删除区要在「关于」之后');
});
