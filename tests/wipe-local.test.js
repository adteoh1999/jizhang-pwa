// 2f Task 5：store.wipeLocal()——登出与删号共用，清完要和全新安装一样
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function make(db) {
  let n = 0;
  let t = Date.parse('2026-11-25T10:00:00.000Z');
  return createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
}
const ALL_META = {
  owner_user_id: 'u-A', lastUserId: 'u-A', session: { user_id: 'u-A' }, loginPending: { email: 'x' },
  'cursor:transactions': { ts: 'T', id: 'I' }, 'cursor:categories': { ts: 'T', id: 'I' }, fullSyncAt: 123,
  syncPromptDismissed: 'u-A', syncErrorVersion: 'v', ownerFlag: { userId: 'u-A', value: true, checkedAt: 1 },
  isOwner: true, isOwnerCheckedAt: 1, 'some:future-key': 1,
};
async function used(db, extraMeta = {}) {
  const store = make(db);
  await store.init();
  await store.setMetas({ ...ALL_META, ...extraMeta });
  await store.saveTransaction({ kind: 'expense', amountMinor: 690, categoryId: 'food', occurredOn: '2026-11-20', note: '早餐' });
  await store.saveCategory({ kind: 'expense', name: '宠物' });
  return store;
}

test('wipeLocal 后资料库内容与全新安装相同（只多一个新的 ledgerId）', async () => {
  const freshDb = createMemoryDb();
  await make(freshDb).init();
  const db = createMemoryDb();
  const store = await used(db);
  await store.wipeLocal();
  assert.deepEqual(await db.getAll('transactions'), await freshDb.getAll('transactions'));
  assert.deepEqual(await db.getAll('categories'), await freshDb.getAll('categories'));
  assert.deepEqual(db.metaKeys(), ['ledgerId']);
  assert.equal(typeof (await db.getMeta('ledgerId')), 'string');
});

test('wipeLocal 后快取也是全新：没有账、只有默认分类、没有「属于谁」的资料、没有待上传', async () => {
  const store = await used(createMemoryDb());
  await store.wipeLocal();
  assert.equal(store.transactions().length, 0);
  assert.equal(store.categories('expense').length, 6);
  assert.ok(!store.categories('expense').some((c) => c.name === '宠物'));
  assert.equal(store.hasOwnedData(), false);
  assert.deepEqual(store.syncCounts(), { pending: 0, errors: 0, txPending: 0, txErrors: 0 });
});

test('wipeLocal 只用一次写入，并通知画面', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  let hits = 0;
  store.subscribe(() => hits++);
  const before = db.calls.length;
  await store.wipeLocal();
  assert.equal(db.calls.length - before, 1);
  assert.equal(hits, 1);
});

test('wipeLocal 后站主快取（isOwner、ownerFlag）都没了', async () => {
  const store = await used(createMemoryDb());
  await store.wipeLocal();
  for (const k of ['isOwner', 'isOwnerCheckedAt', 'ownerFlag', 'session', 'lastUserId', 'owner_user_id']) {
    assert.equal(await store.getMeta(k), undefined, k);
  }
});

test('wipeLocal 保留「安装提示已关」这个设备设定；没设过就不新增', async () => {
  const db = createMemoryDb();
  const store = await used(db, { installHintDismissed: true });
  await store.wipeLocal();
  assert.deepEqual(db.metaKeys(), ['installHintDismissed', 'ledgerId']);
  assert.equal(await db.getMeta('installHintDismissed'), true);
});

test('wipeLocal 每次换新的 ledgerId', async () => {
  const db = createMemoryDb();
  await db.write({ meta: { ledgerId: 'L-old' } }); // 启动前就有的账本代号
  const store = await used(db);
  await store.wipeLocal();
  const a = await db.getMeta('ledgerId');
  await store.wipeLocal();
  const b = await db.getMeta('ledgerId');
  assert.notEqual(a, 'L-old');
  assert.notEqual(a, b);
});

test('S11：同一个 store 里旧的同步一轮写回被挡（owner 已清掉）', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  await store.wipeLocal();
  const before = db.calls.length;
  const row = { id: '00000000-0000-4000-8000-0000000000aa', kind: 'expense', amount_minor: 1, category_id: 'food',
    occurred_on: '2026-11-20', note: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', deleted: false };
  assert.equal(await store.applyRemote('transactions', [row], { owner: 'u-A' }), null);
  assert.equal(await store.clearSyncErrors({ owner: 'u-A' }), null);
  assert.equal(db.calls.length, before);
  assert.equal((await db.getAll('transactions')).length, 0);
});

test('S11：另一个分页（另一个 store）的用户写入被挡（ledgerId 已换）', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  const other = make(db);
  await other.init();
  let changed = 0;
  other.onLedgerChanged(() => changed++);
  await store.wipeLocal();
  await assert.rejects(
    other.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-21', note: '' }),
    (e) => e.name === 'LedgerChanged',
  );
  assert.equal(changed, 1);
  assert.equal((await db.getAll('transactions')).length, 0);
});

test('wipeLocal 写入失败 → reject；资料库与快取都不变', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  db.failNextWrite(new Error('disk'));
  await assert.rejects(store.wipeLocal());
  assert.equal(store.transactions().length, 1);
  assert.equal((await db.getAll('transactions')).length, 1);
  assert.deepEqual(await db.getMeta('session'), { user_id: 'u-A' });
  // 失败后再试一次可以成功
  await store.wipeLocal();
  assert.equal(store.transactions().length, 0);
});

test('wipeLocal 后同一个分页自己还能照常记账（自己的账本代号跟着换新）', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  await store.wipeLocal();
  await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-21', note: '' });
  assert.equal((await db.getAll('transactions')).length, 1);
});

// 2f-2 审核小事：同步引擎写 syncErrorVersion／游标／fullSyncAt 要核对 owner（别的分页清完后不写回）
test('setMeta 带 owner：owner 还是它才写，回 true；不是（或账本已换）→ 回 null、什么都不写', async () => {
  const db = createMemoryDb();
  const store = await used(db);
  assert.equal(await store.setMeta('fullSyncAt', 456, { owner: 'u-A' }), true);
  assert.equal(await store.getMeta('fullSyncAt'), 456);
  assert.equal(await store.setMeta('fullSyncAt', 789, { owner: 'u-B' }), null);
  assert.equal(await store.getMeta('fullSyncAt'), 456);
  // 别的分页清掉（owner 没了、ledgerId 换了）
  const other = make(db);
  await other.init();
  await other.wipeLocal();
  assert.equal(await store.setMeta('fullSyncAt', 999, { owner: 'u-A' }), null);
  assert.equal(await store.getMeta('fullSyncAt'), undefined);
});
