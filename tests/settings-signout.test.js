// 2f Task 10：设置页「登出」——还有没同步的先提醒，登出时清掉这台设备的账本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { runSignOut, SIGNOUT_TEXT as T } from '../js/ui/sign-out.js';
import { runTgUnlinkMiniApp, TG_UNLINK_TEXT as U } from '../js/ui/tg-unlink.js';
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

test('离线、没有未同步 → 内文另起一行「现在离线，联网才能再登录。」', async () => {
  const { dialogs, deps } = await setup({ online: false });
  await runSignOut(deps);
  assert.equal(dialogs.lastConfirm.message, '这台设备上的账本会清除，下次登录会从云端拉回。\n现在离线，联网才能再登录。');
});

test('确认登出 → 停同步与 Realtime、清掉账本、清隐藏金额、通知其他分页，最后才 reload', async () => {
  const { db, store, log, deps } = await setup({ confirms: [true] });
  assert.equal(await runSignOut(deps), 'done');
  assert.ok(log.includes('sync.stop') && log.includes('realtime.stop'));
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

test('对话框开着时断网、再按「先同步」→ 先挡「请连上网络后再同步」、不叫 syncNow，再回到选择', async () => {
  const { log, deps } = await setup({ unsynced: 'tx', choices: ['sync', 'cancel'] });
  let online = true;
  deps.isOnline = () => online;
  const ask = deps.dialogs.choiceDialog;
  deps.dialogs.choiceDialog = async (o) => { const a = await ask(o); online = false; return a; };
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
    assert.ok(log.includes('unblock'), res);
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
  assert.ok(log.indexOf('onStartSync') < log.indexOf(`block:${T.syncingLabel}`), '认领完才挡画面');
});

test('认领没成功（没变成这个账号的）→ 不 syncNow，回到选择', async () => {
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
  assert.equal(o.message, '登出会遗失这些记录。\n登录已过期，现在无法同步。\n账号若已删除，可直接登出。');
});

test('只剩「无法同步」的记录 → 不提供「先同步」，内文说明上传不了', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'error' });
  await runSignOut(deps);
  const o = dialogs.lastChoice;
  assert.equal(o.title, '还有 1 笔没同步');
  assert.deepEqual(o.buttons.map((b) => b.label), ['导出 CSV', '仍要登出', '取消']);
  assert.equal(o.message, '登出会遗失这些记录。\n这些记录上传不了，可以先导出 CSV 保存。');
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
  assert.equal(o.message, '登出会遗失这些记录。\n这本账属于另一个账号，无法同步到这个账号。');
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

// ---------- 2f 整体审核 S-1、小事：对话框开着时别的分页换账号／登出 ----------
test('确认框开着时别的分页换成另一个账号 → 按「登出」也不清那个账号的账本，说明后重新整理', async () => {
  const { db, store, log, deps } = await setup();
  const other = createStore({ db, uuid: () => fakeUuid(900) });
  await other.init();
  deps.dialogs.confirmDialog = async () => {
    await other.setMetas({ session: { ...SESSION, user_id: 'u-B' } });
    return true;
  };
  assert.equal(await runSignOut(deps), 'fail');
  assert.ok(log.includes('message:账号已更换'));
  assert.equal(log.at(-1), 'reload:1');
  assert.equal((await db.getAll('transactions')).length, 1);
  assert.equal((await loadSession(store)).user_id, 'u-B');
});

test('session 已经没有（别的分页登出了）→ 直接重新整理，不弹窗', async () => {
  const { store, log, deps } = await setup();
  await store.setMeta('session', null);
  assert.equal(await runSignOut(deps), 'done');
  assert.deepEqual(log, ['reload:1']);
});

test('确认框开着时别的分页登出了 → 按「登出」直接重新整理，不弹「登出失败」', async () => {
  const { db, log, deps } = await setup();
  const other = createStore({ db, uuid: () => fakeUuid(900) });
  await other.init();
  deps.dialogs.confirmDialog = async () => { await other.wipeLocal(); return true; };
  assert.equal(await runSignOut(deps), 'done');
  assert.ok(!ran(log, 'message:'));
  assert.equal(log.at(-1).startsWith('reload:'), true);
});

// ---------- 2f 整体审核 S-3：判断前从资料库重读（别的分页刚记的账不能没提醒就丢掉）----------
test('别的分页刚记了一笔（这个分页的快取还没更新）→ 仍提醒「还有 1 笔没同步」', async () => {
  const { db, dialogs, deps } = await setup();
  const other = createStore({ db, uuid: () => fakeUuid(900) });
  await other.init();
  await other.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-22', note: '' });
  await runSignOut(deps);
  assert.equal(dialogs.lastChoice && dialogs.lastChoice.title, '还有 1 笔没同步');
});

test('重读时发现账本已被换掉 → 说明「账号已更换」、重新整理，不清资料', async () => {
  const { db, log, deps } = await setup({ confirms: [true] });
  await db.write({ meta: { ledgerId: 'changed-elsewhere' } });
  assert.equal(await runSignOut(deps), 'fail');
  assert.ok(log.includes('message:账号已更换'));
  assert.ok(!ran(log, 'confirm:'));
  assert.equal((await db.getAll('transactions')).length, 1);
});

// ---------- 2f 整体审核 S-5：登出期间（最长约 7 秒）挡住整个画面 ----------
test('确认登出 → 先挡画面「正在登出…」再停同步；成功就不放开（马上 reload）', async () => {
  const { log, deps } = await setup({ confirms: [true] });
  await runSignOut(deps);
  assert.ok(log.includes(`block:${T.busyLabel}`));
  assert.ok(log.indexOf(`block:${T.busyLabel}`) < log.indexOf('sync.stop'));
  assert.ok(!log.includes('unblock'));
});

test('登出失败／账号已更换 → 先放开画面再说明', async () => {
  const a = await setup({ confirms: [true] });
  const real = a.db.write.bind(a.db);
  a.db.write = async (c) => { if (c.clearMeta) throw new Error('disk'); return real(c); };
  const orig = console.warn;
  console.warn = () => {};
  try { await runSignOut(a.deps); } finally { console.warn = orig; }
  assert.ok(a.log.includes('unblock'));
  assert.ok(a.log.indexOf('unblock') < a.log.indexOf('message:登出失败'));

  const b = await setup();
  const other = createStore({ db: b.db, uuid: () => fakeUuid(900) });
  await other.init();
  b.deps.dialogs.confirmDialog = async () => { await other.setMetas({ session: { ...SESSION, user_id: 'u-B' } }); return true; };
  await runSignOut(b.deps);
  assert.ok(b.log.includes('unblock'));
  assert.ok(b.log.indexOf('unblock') < b.log.indexOf('message:账号已更换'));
});

// ---------- 2f 整体审核 S-6：「正在同步…」最多挡一段时间 ----------
test('「先同步」一直没跑完 → 到时限放开画面、说明「还在同步」，回到选择', async () => {
  const { log, dialogs, deps } = await setup({ unsynced: 'tx', choices: ['sync', 'cancel'], syncNow: () => new Promise(() => {}) });
  deps.syncWaitMs = 20;
  assert.equal(await runSignOut(deps), 'cancel');
  assert.ok(log.includes('unblock'));
  assert.ok(log.indexOf('unblock') < log.indexOf('message:还在同步'));
  assert.equal(dialogs.lastMessage.message, '同步还没完成，请稍后再试。');
  assert.equal(log.filter((l) => l.startsWith('choice:')).length, 2);
});

test('「先同步」默认最多等 25 秒', async () => {
  assert.match(read('../js/ui/sign-out.js'), /syncWaitMs = 25_000/);
});

test('还没归属时「先同步」→ onStartSync 带 consented（用户已同意，不再弹认领提示）', async () => {
  const { deps } = await setup({ owner: null, choices: ['sync', 'cancel'], syncNow: async () => 'ok' });
  const args = [];
  deps.onStartSync = async (o) => { args.push(o); return 'mine'; };
  await runSignOut(deps);
  assert.deepEqual(args, [{ consented: true }]);
});

// ---------- 2f 整体审核 S-4（文案用户选）：账号被删的人最常按「重新登录」，那里也要提示 ----------
test('「要重新登录吗？」内文提示账号若已删除改按「登出」', () => {
  assert.ok(read('../js/ui/settings.js').includes("message: '需要网络和邮箱验证码。这台设备上的账本会保留。账号若已删除，请取消后改按「登出」。'"));
});

test('离线时有没同步 → 不提供「先同步」，内文说明离线（小事）', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'tx', online: false });
  await runSignOut(deps);
  const o = dialogs.lastChoice;
  assert.deepEqual(o.buttons.map((b) => b.label), ['导出 CSV', '仍要登出', '取消']);
  assert.equal(o.message, '登出会遗失这些记录。\n现在离线，无法同步，也要连上网络才能再登录。');
});

test('登录已过期又离线 → 内文是过期说明＋离线那句', async () => {
  const { dialogs, deps } = await setup({ unsynced: 'tx', online: false, syncState: 'signed-out', session: { ...SESSION, invalid: true } });
  await runSignOut(deps);
  assert.equal(dialogs.lastChoice.message, '登出会遗失这些记录。\n登录已过期，现在无法同步。\n账号若已删除，可直接登出。\n现在离线，联网才能再登录。');
});

// ---------- 2f 整体审核 S-2：用真的同步引擎——上传／拉取进行到一半按登出，旧一轮回来也写不回 ----------
import { createSync } from '../js/sync.js';

test('同步一轮进行到一半（上传或拉取卡住）按「登出」→ 清完后旧一轮回来什么都写不回（真的同步引擎）', async () => {
  for (const phase of ['upload', 'pull']) {
    const { db, store, deps } = await setup({ unsynced: phase === 'upload' ? 'tx' : 'none', choices: ['signout'], confirms: [true], online: false });
    await store.setMetas({ syncErrorVersion: 'v-test', fullSyncAt: Date.now() });
    let release;
    const gate = new Promise((r) => { release = r; });
    let hit = false;
    const remote = { id: '00000000-0000-4000-8000-000000000777', user_id: 'u-A', kind: 'expense', amount_minor: 5, category_id: 'food', occurred_on: '2026-11-23', note: '', deleted: false, updated_at: '2026-11-25T11:00:00.000Z', server_updated_at: '2026-11-25T11:00:00.000Z' };
    const serverFetch = async (url, init = {}) => {
      const isGet = (init.method || 'GET') === 'GET';
      if ((phase === 'upload' && !isGet) || (phase === 'pull' && isGet && url.includes('/transactions'))) {
        hit = true;
        await gate;
        if (!isGet) { const rows = JSON.parse(init.body); return new Response(JSON.stringify(rows.map((r) => ({ id: r.id, updated_at: r.updated_at }))), { status: 201 }); }
        return new Response(JSON.stringify([remote]), { status: 200 });
      }
      return new Response('[]', { status: isGet ? 200 : 201 });
    };
    const sync = createSync({
      store, fetchFn: serverFetch, userId: 'u-A', appVersion: 'v-test',
      getSession: async () => ({ session: SESSION }), isOnline: () => true, locks: null,
      win: null, doc: null, setTimer: () => 0, clearTimer: () => {},
    });
    const round = sync.syncNow();
    while (!hit) await new Promise((r) => setTimeout(r, 1));
    deps.sync = sync;
    assert.equal(await runSignOut(deps), 'done', phase);
    release();
    await round;
    assert.equal((await db.getAll('transactions')).length, 0, `${phase}：账不能被写回`);
    assert.deepEqual(db.metaKeys(), ['ledgerId'], `${phase}：meta 只剩新的 ledgerId（游标、owner 等都没被写回）`);
  }
});

// ---------- 2f 复核建议 3：认领失败由登出流程自己说明（不叠两个对话框） ----------
test('「先同步」认领失败 → 先说明「没能开始同步」，再回到选择', async () => {
  const { log, deps } = await setup({ owner: null, choices: ['sync', 'cancel'], onStartSync: async () => 'error' });
  await runSignOut(deps);
  assert.ok(log.includes('message:没能开始同步'));
  assert.ok(!log.includes('syncNow'));
  const msgAt = log.indexOf('message:没能开始同步');
  assert.equal(log.filter((l, i) => l.startsWith('choice:') && i > msgAt).length, 1, '说明之后才再出现选择');
});

test('app.js：consented 时认领失败不另外弹「没能开始同步」（由登出流程说明）', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /userStarted = fromUser && !consented;/);
});


// ---------- 3b-10：runSignOut 的 text、beforeWipe ----------
test('runSignOut：text 覆盖部分文字；beforeWipe 回 true → 照常清除、reload', async () => {
  const { log, dialogs, deps } = await setup({ confirms: [true] });
  const order = [];
  const r = await runSignOut({ ...deps, text: { plainTitle: '要解除连接吗？', confirmLabel: '解除连接' }, beforeWipe: async () => { order.push(log.length); log.push('beforeWipe'); return true; } });
  assert.equal(r, 'done');
  assert.equal(dialogs.lastConfirm.title, '要解除连接吗？');
  assert.equal(dialogs.lastConfirm.confirmLabel, '解除连接');
  assert.equal(dialogs.lastConfirm.message, T.plainMessage, '没覆盖的照旧');
  const iBlock = log.findIndex((l) => l.startsWith('block:'));
  const iBefore = log.indexOf('beforeWipe');
  const iStop = log.indexOf('sync.stop');
  assert.ok(iBlock >= 0 && iBefore > iBlock && iStop > iBefore, log.join(' | '));
  assert.ok(ran(log, 'reload:'));
});

test('runSignOut：beforeWipe 回 false 或丢错 → 解除遮罩、回 fail、不清、不 reload', async () => {
  for (const bw of [async () => false, async () => { throw new Error('x'); }]) {
    const { log, store, deps } = await setup({ confirms: [true] });
    assert.equal(await runSignOut({ ...deps, beforeWipe: bw }), 'fail');
    assert.ok(log.includes('unblock'));
    assert.ok(log.includes('busy:false'));
    assert.ok(!ran(log, 'reload:'));
    assert.ok(!log.includes('sync.stop'));
    assert.equal((await loadSession(store)).user_id, 'u-A');
    assert.equal(store.transactions().length, 1);
  }
});

// ---------- 3b-10：Mini App 解除连接（runTgUnlinkMiniApp）----------
function tgDeps(base, { got = { session: SESSION }, unlink = { ok: true, data: { ok: true, unlinked: true, others: true } }, login = null } = {}) {
  const calls = { unlink: [], login: 0, logout: [] };
  return {
    calls,
    deps: {
      ...base.deps,
      env: { initData: 'INIT' },
      getSession: async () => got,
      tgLink: async (token, action) => { calls.unlink.push([token, action]); return unlink; },
      tgLogin: async () => { calls.login += 1; return login; },
      logoutServer: (s) => { calls.logout.push(s.access_token); },
    },
  };
}

test('Mini App 解除连接：确认框文字；unlink 成功 → 清除、reload', async () => {
  const b = await setup({ confirms: [true] });
  const { deps, calls } = tgDeps(b);
  assert.equal(await runTgUnlinkMiniApp(deps), 'done');
  assert.equal(b.dialogs.lastConfirm.title, '要解除连接吗？');
  assert.equal(b.dialogs.lastConfirm.message, '这台设备上的账本会清除。这个账号在其他设备（包括 iPhone 的 PWA）也会被登出，最晚 1 小时内生效。');
  assert.equal(b.dialogs.lastConfirm.confirmLabel, '解除连接');
  assert.deepEqual(calls.unlink, [['tok-A', 'unlink']]);
  assert.ok(ran(b.log, 'reload:0'));
});

test('Mini App 解除连接：unlink 失败 → 「没能解除连接，请稍后再试」、没清、没 reload', async () => {
  const b = await setup({ confirms: [true] });
  const { deps } = tgDeps(b, { unlink: { ok: false, status: 500, code: null, error: '暂时无法连接，请稍后再试', retry: true } });
  assert.equal(await runTgUnlinkMiniApp(deps), 'fail');
  assert.equal(b.dialogs.lastMessage.title, U.failTitle);
  assert.equal(U.failTitle, '没能解除连接，请稍后再试');
  assert.ok(!ran(b.log, 'reload:'));
  assert.equal(b.store.transactions().length, 1);
});

test('Mini App 解除连接：离线 → 「需要网络才能解除连接」，不叫服务器、不清', async () => {
  const b = await setup({ confirms: [true], online: false });
  const { deps, calls } = tgDeps(b);
  assert.equal(await runTgUnlinkMiniApp(deps), 'fail');
  assert.equal(b.dialogs.lastMessage.title, '需要网络才能解除连接');
  assert.equal(calls.unlink.length, 0);
  assert.ok(!ran(b.log, 'reload:'));
});

test('Mini App 解除连接：token 失效＋tg-login 说没连接 → 不叫 unlink、直接清', async () => {
  const b = await setup({ confirms: [true] });
  const { deps, calls } = tgDeps(b, { got: { invalid: true }, login: { ok: true, status: 'unlinked', label: '', bindDeadline: null } });
  assert.equal(await runTgUnlinkMiniApp(deps), 'done');
  assert.equal(calls.login, 1);
  assert.equal(calls.unlink.length, 0);
  assert.ok(ran(b.log, 'reload:0'));
});

test('Mini App 解除连接：token 失效＋tg-login 换到同账号的新 session → 用它 unlink，之后不管成败都作废它（r2-M2-4）', async () => {
  for (const unlink of [{ ok: true, data: { ok: true, unlinked: true, others: true } }, { ok: false, status: 500, code: null, error: 'x', retry: true }]) {
    const b = await setup({ confirms: [true] });
    const fresh = { ...SESSION, access_token: 'tok-NEW' };
    const { deps, calls } = tgDeps(b, { got: { invalid: true }, login: { ok: true, status: 'linked', session: fresh, label: '' }, unlink });
    await runTgUnlinkMiniApp(deps);
    assert.deepEqual(calls.unlink, [['tok-NEW', 'unlink']]);
    assert.deepEqual(calls.logout, ['tok-NEW']);
  }
});

test('Mini App 解除连接：session 或 tg-login 换来的是别的账号 → 不叫 unlink、不清（新 session 先作废）', async () => {
  const b1 = await setup({ confirms: [true] });
  const x1 = tgDeps(b1, { got: { session: { ...SESSION, user_id: 'u-B' } } });
  assert.equal(await runTgUnlinkMiniApp(x1.deps), 'fail');
  assert.equal(x1.calls.unlink.length, 0);
  const b2 = await setup({ confirms: [true] });
  const x2 = tgDeps(b2, { got: { invalid: true }, login: { ok: true, status: 'linked', session: { ...SESSION, user_id: 'u-B', access_token: 'tok-B' }, label: '' } });
  assert.equal(await runTgUnlinkMiniApp(x2.deps), 'fail');
  assert.equal(x2.calls.unlink.length, 0);
  assert.deepEqual(x2.calls.logout, ['tok-B']);
  assert.ok(!ran(b2.log, 'reload:'));
});

test('Mini App 解除连接：others:false → 先说明「已解除连接，但没能登出其他设备」再清除', async () => {
  const b = await setup({ confirms: [true] });
  const { deps } = tgDeps(b, { unlink: { ok: true, data: { ok: true, unlinked: true, others: false } } });
  assert.equal(await runTgUnlinkMiniApp(deps), 'done');
  assert.ok(b.log.includes('message:已解除连接，但没能登出其他设备'));
  assert.ok(ran(b.log, 'reload:0'));
});

test('Mini App 解除连接：有没同步的 → 先同步／仍要解除连接／取消；Telegram 里没有「导出 CSV」（用户 2026-11-26 决定）', async () => {
  const b = await setup({ unsynced: 'tx', choices: ['cancel'] });
  const { deps } = tgDeps(b);
  assert.equal(await runTgUnlinkMiniApp(deps), 'cancel');
  assert.deepEqual(b.dialogs.lastChoice.buttons.map((x) => x.label), [T.syncLabel, '仍要解除连接', T.cancelLabel]);
});

test('runSignOut：exportable:false → 没有「导出 CSV」；不给时照旧有', async () => {
  const a = await setup({ unsynced: 'tx', choices: ['cancel'] });
  await runSignOut({ ...a.deps, exportable: false });
  assert.ok(!a.dialogs.lastChoice.buttons.some((x) => x.label === T.exportLabel));
  const b = await setup({ unsynced: 'tx', choices: ['cancel'] });
  await runSignOut(b.deps);
  assert.ok(b.dialogs.lastChoice.buttons.some((x) => x.label === T.exportLabel));
});

test('审核：Mini App 解除连接，token 失效＋tg-login 回 stale → 「请关掉后重新打开再试」', async () => {
  const b = await setup({ confirms: [true] });
  const { deps } = tgDeps(b, { got: { invalid: true }, login: { ok: true, status: 'stale' } });
  assert.equal(await runTgUnlinkMiniApp(deps), 'fail');
  assert.equal(b.dialogs.lastMessage.title, U.staleTitle);
  assert.equal(U.staleTitle, '请关掉后重新打开再试');
});

test('审核：Mini App 解除连接的文字没有「登出」（未同步、离线、失败都换掉）', async () => {
  const b = await setup({ unsynced: 'tx', online: false, choices: ['cancel'] });
  const { deps } = tgDeps(b);
  await runTgUnlinkMiniApp(deps);
  assert.doesNotMatch(b.dialogs.lastChoice.message, /登出|登录/);
  for (const k of ['unsyncedMessage', 'offlineNote', 'reasonSignedOut', 'reasonOffline', 'reasonErrors', 'failTitle']) {
    assert.ok(U.mini[k] && !/登出/.test(U.mini[k]), k);
  }
});
