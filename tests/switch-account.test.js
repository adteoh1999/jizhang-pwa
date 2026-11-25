// 2e-2 任务 9：换账号（store.resetForAccount、写回前核对 owner）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { DEFAULT_EPOCH } from '../js/model.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup() {
  let n = 0;
  let t = Date.parse('2026-11-25T10:00:00.000Z');
  const db = createMemoryDb();
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  await store.setMetas({ owner_user_id: 'u-A', lastUserId: 'u-A', session: { user_id: 'u-A' }, loginPending: { email: 'x' }, 'cursor:transactions': { ts: 'T', id: 'I' }, 'cursor:categories': { ts: 'T', id: 'I' }, fullSyncAt: 123, syncPromptDismissed: 'u-A', syncErrorVersion: 'v' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.saveCategory({ kind: 'expense', name: '宠物' });
  return { db, store };
}

test('resetForAccount：一次写入清空账与分类、重建默认分类（dirty 1、epoch）、owner 换新、游标与完整对账时间清掉；其他 meta 不动', async () => {
  const { db, store } = await setup();
  let hits = 0;
  store.subscribe(() => hits++);
  const before = db.calls.length;
  await store.resetForAccount('u-B', { meta: { session: { user_id: 'u-B' }, lastUserId: 'u-B' } });
  assert.equal(db.calls.length - before, 1);
  assert.equal(hits, 1);
  assert.equal(store.transactions().length, 0);
  assert.equal((await db.getAll('transactions')).length, 0);
  const cats = await db.getAll('categories');
  assert.equal(cats.length, 10);
  assert.ok(cats.every((c) => c.dirty === 1 && c.updated_at === DEFAULT_EPOCH && !c.deleted));
  assert.equal(store.categories('expense').length, 6);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
  assert.deepEqual(await store.getMeta('session'), { user_id: 'u-B' });
  assert.equal(await store.getMeta('lastUserId'), 'u-B');
  for (const k of ['cursor:transactions', 'cursor:categories', 'fullSyncAt', 'syncPromptDismissed']) assert.equal(await store.getMeta(k), null, k);
  assert.deepEqual(await store.getMeta('loginPending'), { email: 'x' });
  assert.equal(await store.getMeta('syncErrorVersion'), 'v');
  assert.equal(store.syncCounts().pending, 10);
});

test('resetForAccount 写入失败 → reject；资料、owner、session 都还在', async () => {
  const { db, store } = await setup();
  db.failNextWrite(new Error('disk'));
  await assert.rejects(store.resetForAccount('u-B', { meta: { session: { user_id: 'u-B' } } }));
  assert.equal(store.transactions().length, 1);
  assert.equal((await db.getAll('transactions')).length, 1);
  assert.ok(store.categories('expense').some((c) => c.name === '宠物'));
  assert.equal(await store.getMeta('owner_user_id'), 'u-A');
  assert.deepEqual(await store.getMeta('session'), { user_id: 'u-A' });
});

test('审核 5 S-4：owner 换了之后，旧引擎的写回（markUploaded / markSyncError / clearSyncErrors）不写', async () => {
  const { db, store } = await setup();
  const sent = await store.pendingRows('transactions');
  await store.setMeta('owner_user_id', 'u-B');
  const before = db.calls.length;
  assert.equal(await store.markUploaded('transactions', sent, [], { owner: 'u-A' }), null);
  assert.equal(await store.markSyncError('transactions', sent[0].id, '23514', sent[0].updated_at, { owner: 'u-A' }), null);
  assert.equal(await store.clearSyncErrors({ owner: 'u-A' }), null);
  assert.equal(db.calls.length, before);
  assert.equal(store.syncCounts().txPending, 1);
  // owner 相同 → 照常
  await store.markUploaded('transactions', sent, [], { owner: 'u-B' });
  assert.equal(store.syncCounts().txPending, 0);
});

test('上传途中别的分页换了账号（owner 变 B）→ 旧引擎不写回、停下（other-owner）、不拉取', async () => {
  const { createSync } = await import('../js/sync.js');
  const { store, db } = await setup();
  const SESSION = { access_token: 't', user_id: 'u-A' };
  let gets = 0;
  const fetchFn = async (url, init = {}) => {
    if (init.method !== 'POST') { gets++; return new Response('[]', { status: 200 }); }
    await store.setMeta('owner_user_id', 'u-B'); // 别的分页 resetForAccount
    const rows = JSON.parse(init.body);
    return new Response(JSON.stringify(rows.map((r) => ({ id: r.id, updated_at: r.updated_at }))), { status: 201 });
  };
  await store.setMeta('syncErrorVersion', 'v');
  const sync = createSync({ store, fetchFn, userId: 'u-A', appVersion: 'v', getSession: async () => ({ session: SESSION }),
    isOnline: () => true, win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: 'visible' }), locks: null,
    setTimer: () => 0, clearTimer: () => {} });
  const before = db.calls.length;
  assert.equal(await sync.syncNow(), 'halt');
  assert.equal(sync.status().state, 'other-owner');
  assert.equal(db.calls.length - before, 1); // 只有测试自己写的 owner
  assert.equal(gets, 0);
});

test('换账号对话框文字（HIG：标题短、说清楚会丢什么、给出安全出路）', async () => {
  const { LOGIN_TEXT: T } = await import('../js/ui/login.js');
  assert.equal(T.switchTitle(3), '还有 3 笔记录没上传');
  assert.equal(T.switchTitle(0), '还有没上传的改动');
  assert.equal(T.switchMessage, '换成新账号会清除这台设备上的账本。已上传的记录还在原来的账号里，没上传的会消失。可以先导出 CSV，或取消后用原来的账号登录、等它上传完。');
  assert.equal(T.switchExport, '导出 CSV');
  assert.equal(T.switchClear, '清除并登录');
  assert.equal(T.switchCancel, '取消登录');
  assert.equal(T.clearTitle, '清除没上传的记录？');
  assert.equal(T.clearMessage, 'CSV 存好了吗？清除后无法恢复。');
  assert.equal(T.clearConfirm, '清除');
});

function fakeDialogs(choices, confirms) {
  const log = [];
  return {
    log,
    choice: async (opts) => { log.push(['choice', opts]); return choices.shift(); },
    confirm: async (opts) => { log.push(['confirm', opts]); return confirms.shift(); },
    exporter: () => () => log.push(['export']),
  };
}

test('askReset：清除 → 第二个取消 → 回第一个 → 取消登录 → false', async () => {
  const { askReset } = await import('../js/ui/login.js');
  const d = fakeDialogs(['clear', 'cancel'], [false]);
  assert.equal(await askReset({}, { txCount: 2 }, d), false);
  assert.deepEqual(d.log.map((x) => x[0]), ['choice', 'confirm', 'choice']);
  const [, first] = d.log[0];
  assert.equal(first.title, '还有 2 笔记录没上传');
  assert.deepEqual(first.buttons.map((b) => [b.label, !!b.keepOpen, !!b.destructive, !!b.focus, b.value]),
    [['导出 CSV', true, false, false, undefined], ['清除并登录', false, true, false, 'clear'], ['取消登录', false, false, true, 'cancel']]);
  first.buttons[0].onClick();
  assert.deepEqual(d.log.at(-1), ['export']);
  assert.equal(d.log[1][1].destructive, true);
});

test('askReset：清除 → 确认 → true；Esc（null）→ false', async () => {
  const { askReset } = await import('../js/ui/login.js');
  assert.equal(await askReset({}, { txCount: 0 }, fakeDialogs(['clear'], [true])), true);
  assert.equal(await askReset({}, { txCount: 0 }, fakeDialogs([null], [])), false);
});

test('db.write expect：meta 值不符 → reject（MetaMismatch）、什么都不写；相符 → 写；null 与没有视为相同', async () => {
  const db = createMemoryDb();
  await db.write({ meta: { owner_user_id: 'u-A' } });
  await assert.rejects(db.write({ expect: { owner_user_id: 'u-B' }, transactions: [{ id: 'x' }], meta: { k: 1 } }), (e) => e.name === 'MetaMismatch');
  assert.equal((await db.getAll('transactions')).length, 0);
  assert.equal(await db.getMeta('k'), undefined);
  await db.write({ expect: { owner_user_id: 'u-A', ledgerId: null }, transactions: [{ id: 'x' }] });
  assert.equal((await db.getAll('transactions')).length, 1);
});

test('审核 M-2：别的分页清除后，旧分页的用户写入被挡（LedgerChanged）、通知画面、资料库不变', async () => {
  const db = createMemoryDb();
  const s1 = createStore({ db });
  await s1.init();
  const s2 = createStore({ db });
  await s2.init();
  const t = await s2.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await s1.init();
  let stale = 0;
  s2.onLedgerChanged(() => stale++);
  await s1.resetForAccount('u-B');
  const before = db.calls.length;
  await assert.rejects(s2.saveTransaction({ kind: 'expense', amountMinor: 2, categoryId: 'food', occurredOn: '2026-11-20', note: '' }), (e) => e.name === 'LedgerChanged');
  await assert.rejects(s2.deleteTransaction(t.id), (e) => e.name === 'LedgerChanged');
  assert.equal(db.calls.length, before);
  assert.equal(stale, 2);
  assert.equal((await db.getAll('transactions')).length, 0);
  // 清除的那个分页自己照常能写
  await s1.saveTransaction({ kind: 'expense', amountMinor: 3, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
});

test('审核 S-1：owner 核对与写入是同一次操作（读完 owner 之后才被换掉也挡得住）', async () => {
  const { db, store } = await setup();
  const sent = await store.pendingRows('transactions');
  const real = db.getMeta;
  db.getMeta = async (k) => { const v = await real(k); if (k === 'owner_user_id') await db.write({ meta: { owner_user_id: 'u-B' } }); return v; };
  assert.equal(await store.markUploaded('transactions', sent, [], { owner: 'u-A' }), null);
  db.getMeta = real;
  assert.equal(store.syncCounts().txPending, 1);
});

test('unsyncedInfo：已归属只数 dirty / sync_error（不算没改过的默认分类）；txCount 只数看得到的账', async () => {
  const { store } = await setup(); // 1 笔账 + 1 个自建分类，都 dirty
  assert.deepEqual(store.unsyncedInfo(), { any: true, txCount: 1 });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
  await store.markUploaded('categories', await store.pendingRows('categories'), []);
  assert.deepEqual(store.unsyncedInfo(), { any: false, txCount: 0 });
  assert.deepEqual(store.unsyncedInfo({ all: true }), { any: true, txCount: 1 }); // 没归属：整本都算
  await store.resetForAccount('u-B');
  assert.deepEqual(store.unsyncedInfo(), { any: false, txCount: 0 });
  assert.deepEqual(store.unsyncedInfo({ all: true }), { any: false, txCount: 0 });
});
