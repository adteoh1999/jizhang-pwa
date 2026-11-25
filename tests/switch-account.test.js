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

test('换账号对话框文字（HIG：具体动词、取消在最下、清除用红字、二次确认）', async () => {
  const { LOGIN_TEXT: T } = await import('../js/ui/login.js');
  assert.equal(T.switchTitle(3), '这台设备上有 3 笔另一个账号还没上传的记录');
  assert.equal(T.switchTitle(0), '这台设备上有另一个账号还没上传的记录');
  assert.equal(T.switchMessage, '登录新账号会清除这台设备上的账本。请先导出 CSV 备份。');
  assert.equal(T.switchExport, '导出 CSV');
  assert.equal(T.switchClear, '清除并登录');
  assert.equal(T.switchCancel, '取消登录');
  assert.equal(T.clearTitle, '清除这台设备上的账本？');
  assert.equal(T.clearMessage, 'CSV 存好了吗？清除后无法恢复。');
  assert.equal(T.clearConfirm, '清除');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function askReset'));
  assert.match(body, /createExporter\(store\)/);
  assert.match(body, /keepOpen: true, onClick: exportCsv/);
  assert.match(body, /destructive: true, value: 'clear'/);
  assert.match(body, /value: 'cancel', focus: true/);
  assert.match(body, /confirmDialog\(\{[^}]*destructive: true/);
  assert.match(src, /confirmReset: \(info\) => askReset\(store, info\)/);
  const dialogs = readFileSync(new URL('../js/ui/dialogs.js', import.meta.url), 'utf8');
  assert.match(dialogs.slice(dialogs.indexOf('export function choiceDialog')), /style: b\.destructive \? 'destructive' : 'default'/);
});
