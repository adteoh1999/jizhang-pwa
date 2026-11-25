// 2f Task 10：设置页「登出」——还有没同步的先提醒，登出时清掉这台设备的账本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { runSignOut, SIGNOUT_TEXT as T } from '../js/ui/sign-out.js';
import { loadSession } from '../js/auth.js';
import { HIDE_KEY } from '../js/ui/home.js';
import { SUPABASE_URL } from '../js/config.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAR = Date.parse('2099-01-01T00:00:00Z');
const SESSION = { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: FAR, user_id: 'u-A', email: 'a@example.invalid', platform: 'pwa' };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * unsynced：'none'（都传上去了）| 'tx'（1 笔账待上传）| 'cat'（只有分类改动）| 'error'（只剩无法同步）
 * owner：账本属于谁（null＝还没归属）。choices／confirms：对话框依序回的答案。
 */
async function setup({
  unsynced = 'none', owner = 'u-A', session = SESSION, online = true, syncState = 'idle',
  choices = [], confirms = [], syncNow, onStartSync, userId = 'u-A',
} = {}) {
  let n = 0;
  const db = createMemoryDb();
  const store = createStore({ db, uuid: () => fakeUuid(++n) });
  await store.init();
  await store.setMetas({ session, lastUserId: 'u-A', ...(owner ? { owner_user_id: owner } : {}) });
  await store.saveTransaction({ kind: 'expense', amountMinor: 690, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  const uploadAll = async () => {
    await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
    await store.markUploaded('categories', await store.pendingRows('categories'), []);
  };
  await uploadAll();
  if (unsynced === 'tx') await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-21', note: '' });
  if (unsynced === 'cat') await store.saveCategory({ kind: 'expense', name: '宠物' });
  if (unsynced === 'error') {
    const t = await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-21', note: '' });
    await store.markSyncError('transactions', t.id, '23514', t.updated_at, { owner: 'u-A' });
  }
  const log = [];
  const fetchFn = async (url) => {
    log.push(`fetch:${url.replace(SUPABASE_URL, '')}`);
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
    throw new Error(`没有设定的网址：${url}`);
  };
  const ch = [...choices];
  const cf = [...confirms];
  const dialogs = {
    choices: [],
    choiceDialog: async (o) => { log.push(`choice:${o.title}`); dialogs.choices.push(o); dialogs.lastChoice = o; return ch.length ? ch.shift() : 'cancel'; },
    confirmDialog: async (o) => { log.push(`confirm:${o.title}`); dialogs.lastConfirm = o; return cf.length ? cf.shift() : false; },
    messageDialog: async (o) => { log.push(`message:${o.title}`); dialogs.lastMessage = o; },
  };
  const sync = {
    stop: () => log.push('sync.stop'),
    status: () => ({ state: syncState }),
    syncNow: async () => { log.push('syncNow'); return syncNow ? syncNow({ store, uploadAll }) : 'ok'; },
  };
  const deps = {
    store, userId, fetchFn, dialogs, sync,
    realtime: { stop: () => log.push('realtime.stop') },
    onStartSync: async () => { log.push('onStartSync'); return onStartSync ? onStartSync({ store }) : 'mine'; },
    storage: { removeItem: (k) => log.push(`storage.remove:${k}`) },
    isOnline: () => online,
    reload: () => log.push(`reload:${store.transactions().length}`),
    announce: () => log.push('announce'),
    onBusy: (b) => log.push(`busy:${b}`),
    block: (text) => { log.push(`block:${text}`); return () => log.push('unblock'); },
    exportCsv: () => log.push('export'),
  };
  return { db, store, log, dialogs, deps, uploadAll };
}
const ran = (log, prefix) => log.some((l) => l.startsWith(prefix));

test('没有未同步 → 一个确认框（标题、内文、红字「登出」）', async () => {
  const { log, dialogs, deps } = await setup();
  assert.equal(await runSignOut(deps), 'cancel');
  assert.deepEqual(log, ['confirm:要登出吗？']);
  const o = dialogs.lastConfirm;
  assert.equal(o.message, '这台设备上的账本会清除，下次登录会从云端拉回。');
  assert.equal(o.confirmLabel, '登出');
  assert.equal(o.destructive, true);
});

test('离线、没有未同步 → 内文多一句「现在离线，要连上网络才能再登录。」', async () => {
  const { dialogs, deps } = await setup({ online: false });
  await runSignOut(deps);
  assert.equal(dialogs.lastConfirm.message, '这台设备上的账本会清除，下次登录会从云端拉回。现在离线，要连上网络才能再登录。');
});

test('确认登出 → 停同步与 Realtime、清掉账本、清隐藏金额、通知其他分页，最后才 reload', async () => {
  const { db, store, log, deps } = await setup({ confirms: [true] });
  assert.equal(await runSignOut(deps), 'done');
  assert.ok(log.indexOf('sync.stop') > 0 && log.indexOf('realtime.stop') > 0);
  assert.ok(log.indexOf('realtime.stop') < log.indexOf('fetch:/auth/v1/logout?scope=local'));
  assert.equal(log.at(-1), 'reload:0');
  // 先断言有出现（indexOf 找不到是 -1，比先后会误过）
  for (const k of [`storage.remove:${HIDE_KEY}`, 'announce', 'busy:true']) assert.ok(log.includes(k), k);
  assert.ok(log.indexOf(`storage.remove:${HIDE_KEY}`) < log.indexOf('reload:0'));
  assert.ok(log.indexOf('announce') < log.indexOf('reload:0'));
  assert.ok(log.indexOf('busy:true') < log.indexOf('sync.stop'), '按下后先显示「正在登出…」');
  assert.equal((await db.getAll('transactions')).length, 0);
  assert.equal(store.transactions().length, 0);
  assert.equal(await loadSession(store), null);
  assert.equal(await db.getMeta('owner_user_id'), undefined);
});

test('有未同步 → 四个按钮（先同步／导出 CSV 不关窗／仍要登出红字／取消有焦点）、标题带笔数', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'tx' });
  assert.equal(await runSignOut(deps), 'cancel');
  const o = dialogs.lastChoice;
  assert.equal(o.title, '还有 1 笔没同步');
  assert.equal(o.message, '登出会遗失这些记录。');
  assert.deepEqual(o.buttons.map((b) => b.label), ['先同步', '导出 CSV', '仍要登出', '取消']);
  assert.equal(o.buttons[1].keepOpen, true);
  assert.equal(o.buttons[2].destructive, true);
  assert.ok(!o.buttons[2].bold, '破坏性按钮不设为默认');
  assert.equal(o.buttons[3].focus, true);
});

test('只有分类改动没同步 → 标题「还有改动没同步」', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'cat' });
  await runSignOut(deps);
  assert.equal(dialogs.lastChoice.title, '还有改动没同步');
});

test('账本还没归属（从没同步过）→ 整本都算没同步（审核 S12）', async () => {
  const { dialogs, deps } = await setup({ owner: null });
  await runSignOut(deps);
  assert.equal(dialogs.lastChoice.title, '还有 1 笔没同步');
});

test('按「导出 CSV」会叫导出（不关窗）', async () => {
  const { log, dialogs, deps } = await setup({ unsynced: 'tx' });
  await runSignOut(deps);
  dialogs.lastChoice.buttons[1].onClick();
  assert.ok(log.includes('export'));
});

test('取消 → 什么都不动（没停同步、没发请求、账本还在）', async () => {
  const { db, store, log, deps } = await setup({ unsynced: 'tx' });
  assert.equal(await runSignOut(deps), 'cancel');
  assert.deepEqual(log, ['choice:还有 1 笔没同步']);
  assert.equal((await db.getAll('transactions')).length, 2);
  assert.equal((await loadSession(store)).user_id, 'u-A');
});

test('「仍要登出」→ 照样清掉', async () => {
  const { db, log, deps } = await setup({ unsynced: 'tx', choices: ['signout'] });
  assert.equal(await runSignOut(deps), 'done');
  assert.ok(!ran(log, 'confirm:'), '不再多问一次');
  assert.equal((await db.getAll('transactions')).length, 0);
  assert.equal(log.at(-1), 'reload:0');
});

test('「先同步」成功、都传上去了 → 变成一个确认框；确认后登出', async () => {
  const { db, log, deps } = await setup({
    unsynced: 'tx', choices: ['sync'], confirms: [true],
    syncNow: async ({ uploadAll }) => { await uploadAll(); return 'ok'; },
  });
  assert.equal(await runSignOut(deps), 'done');
  assert.deepEqual(log.slice(0, 5), ['choice:还有 1 笔没同步', `block:${T.syncingLabel}`, 'syncNow', 'unblock', 'confirm:要登出吗？']);
  assert.equal((await db.getAll('transactions')).length, 0);
});

test('「先同步」后还有没传上去的 → 再问一次', async () => {
  const { log, deps } = await setup({ unsynced: 'tx', choices: ['sync', 'cancel'], syncNow: async () => 'ok' });
  assert.equal(await runSignOut(deps), 'cancel');
  assert.equal(log.filter((l) => l.startsWith('choice:')).length, 2);
});

test('「先同步」时离线 → 先挡「请连上网络后再同步」、不叫 syncNow，再回到选择', async () => {
  const { log, deps } = await setup({ unsynced: 'tx', online: false, choices: ['sync', 'cancel'] });
  await runSignOut(deps);
  assert.ok(log.includes('message:请连上网络后再同步'));
  assert.ok(!log.includes('syncNow'));
  assert.equal(log.filter((l) => l.startsWith('choice:')).length, 2);
});

test('「先同步」失败／另一个分页在同步／被暂停 → 说明原因，再回到选择（审核 S13）', async () => {
  for (const [res, title, msg] of [
    ['fail', '没能同步', '暂时连不上服务器，请稍后再试。'],
    ['skip', '没能同步', '另一个分页正在同步，请稍后再试。'],
    ['halt', '没能同步', '现在无法同步，请稍后再试。'],
  ]) {
    const { log, dialogs, deps } = await setup({ unsynced: 'tx', choices: ['sync', 'cancel'], syncNow: async () => res });
    await runSignOut(deps);
    assert.ok(log.includes(`message:${title}`), res);
    assert.equal(dialogs.lastMessage.message, msg, res);
    assert.ok(log.indexOf('unblock') < log.indexOf(`message:${title}`), `${res}：先放开「正在同步…」`);
    assert.equal(log.filter((l) => l.startsWith('choice:')).length, 2, res);
  }
});

test('同步中 syncNow 丢错 → 放开「正在同步…」、说明失败，不会卡住', async () => {
  const { log, deps } = await setup({ unsynced: 'tx', choices: ['sync', 'cancel'], syncNow: async () => { throw new Error('boom'); } });
  const orig = console.warn;
  console.warn = () => {};
  try { assert.equal(await runSignOut(deps), 'cancel'); } finally { console.warn = orig; }
  assert.ok(log.includes('unblock'));
  assert.ok(log.includes('message:没能同步'));
});

test('账本还没归属时「先同步」走认领（onStartSync），认领成功才 syncNow（审核 S12）', async () => {
  const { log, deps } = await setup({ owner: null, choices: ['sync', 'cancel'], syncNow: async () => 'ok' });
  await runSignOut(deps);
  assert.ok(log.indexOf('onStartSync') >= 0);
  assert.ok(log.indexOf('onStartSync') < log.indexOf('syncNow'));
  assert.ok(log.indexOf('onStartSync') < log.indexOf(`block:${T.syncingLabel}`), '认领可能先问一次，问完才挡画面');
});

test('认领没成功（用户在认领提示按了关掉）→ 不 syncNow，回到选择', async () => {
  const { log, deps } = await setup({ owner: null, choices: ['sync', 'cancel'], onStartSync: async () => 'unclaimed' });
  await runSignOut(deps);
  assert.ok(!log.includes('syncNow'));
  assert.equal(log.filter((l) => l.startsWith('choice:')).length, 2);
});

test('登录已过期 → 不提供「先同步」，内文说明、提示账号若已删除直接登出', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'tx', syncState: 'signed-out', session: { ...SESSION, invalid: true } });
  await runSignOut(deps);
  const o = dialogs.lastChoice;
  assert.deepEqual(o.buttons.map((b) => b.label), ['导出 CSV', '仍要登出', '取消']);
  assert.equal(o.message, '登出会遗失这些记录。登录已过期，现在无法同步。账号若已删除，直接登出即可。');
});

test('只剩「无法同步」的记录 → 不提供「先同步」，内文说明上传不了', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'error' });
  await runSignOut(deps);
  const o = dialogs.lastChoice;
  assert.equal(o.title, '还有 1 笔没同步');
  assert.deepEqual(o.buttons.map((b) => b.label), ['导出 CSV', '仍要登出', '取消']);
  assert.equal(o.message, '登出会遗失这些记录。这些记录上传不了，可以先导出 CSV 保存。');
});

test('登录已过期又离线 → 「仍要登出」不发请求、照样清掉', async () => {
  const { db, log, deps } = await setup({ unsynced: 'tx', online: false, syncState: 'signed-out', session: { ...SESSION, invalid: true }, choices: ['signout'] });
  assert.equal(await runSignOut(deps), 'done');
  assert.ok(!ran(log, 'fetch:'));
  assert.equal((await db.getAll('transactions')).length, 0);
});

test('账本属于另一个账号 → 不提供「先同步」，内文说明无法同步到这个账号', async () => {
  const { dialogs, deps } = await setup({ owner: 'u-OTHER', unsynced: 'tx' });
  await runSignOut(deps);
  const o = dialogs.lastChoice;
  assert.deepEqual(o.buttons.map((b) => b.label), ['导出 CSV', '仍要登出', '取消']);
  assert.equal(o.message, '登出会遗失这些记录。这本账属于另一个账号，无法同步到这个账号。');
});

test('别的分页已换成另一个账号 → 说明「账号已更换」、重新整理，不清资料', async () => {
  const { db, log, deps } = await setup({ session: { ...SESSION, user_id: 'u-B' }, confirms: [true] });
  assert.equal(await runSignOut(deps), 'fail');
  assert.deepEqual(log, ['message:账号已更换', 'reload:1']);
  assert.equal((await db.getAll('transactions')).length, 1);
});

test('清除失败 → 复位「登出」、说明登出失败、重新整理（同步已停），账本还在', async () => {
  const { db, log, deps } = await setup({ confirms: [true] });
  const orig = console.warn;
  console.warn = () => {};
  const real = db.write.bind(db);
  db.write = async (c) => { if (c.clearMeta) throw new Error('disk'); return real(c); };
  try { assert.equal(await runSignOut(deps), 'fail'); } finally { console.warn = orig; }
  assert.ok(log.includes('busy:false'));
  assert.ok(log.indexOf('busy:false') < log.indexOf('message:登出失败'));
  assert.equal(log.at(-1), 'reload:1');
  assert.ok(!ran(log, 'storage.remove') && !log.includes('announce'));
  assert.equal((await db.getAll('transactions')).length, 1);
});

test('进行中再按一次 → 直接回 cancel', async () => {
  let release;
  const { deps } = await setup();
  deps.dialogs.confirmDialog = () => new Promise((r) => { release = r; });
  const p = runSignOut(deps);
  assert.equal(await runSignOut(deps), 'cancel');
  while (!release) await new Promise((r) => setTimeout(r, 1));
  assert.equal(await runSignOut(deps), 'cancel', '对话框开着时再按也不会再跑一次');
  release(false);
  assert.equal(await p, 'cancel');
});

test('设置页接线：登出列交给 runSignOut（带挂载时的账号、realtime、onStartSync），忙碌用 aria-disabled', () => {
  const s = read('../js/ui/settings.js');
  const at = s.indexOf('runSignOut({');
  assert.ok(at >= 0, '要叫 runSignOut');
  const call = s.slice(at, s.indexOf('})', at));
  for (const k of ['userId: session.user_id', 'realtime', 'onStartSync', 'onBusy']) assert.ok(call.includes(k), k);
  assert.doesNotMatch(s, /signOutBtn\.disabled/);
  assert.doesNotMatch(s, /这台设备上的账本会保留。', confirmLabel: '登出'/);
});
