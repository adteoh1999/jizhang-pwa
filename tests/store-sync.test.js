// 2e 任务 3：store 给同步用的方法（js/store.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { DEFAULT_EPOCH } from '../js/model.js';
import { isUuid } from '../js/timefmt.js';

const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup({ db = createMemoryDb(), start = Date.parse('2026-11-25T10:00:00.000Z') } = {}) {
  let n = 0;
  let t = start;
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  return { db, store };
}
const input = (o = {}) => ({ kind: 'expense', amountMinor: 1250, categoryId: 'food', occurredOn: '2026-11-20', note: '', ...o });
const rowOf = async (db, table, id) => (await db.getAll(table)).find((r) => r.id === id);

test('pendingRows：dirty 1 且没有 sync_error 的列（含已删除），回复制品', async () => {
  const { store } = await setup();
  const a = await store.saveTransaction(input());
  const b = await store.saveTransaction(input({ amountMinor: 2 }));
  await store.deleteTransaction(b.id);
  const rows = await store.pendingRows('transactions');
  assert.deepEqual(rows.map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal(rows.find((r) => r.id === b.id).deleted, true);
  rows[0].amount_minor = 999; // 复制品：改了不影响快取
  assert.notEqual((await store.pendingRows('transactions')).find((r) => r.id === rows[0].id).amount_minor, 999);
  assert.equal((await store.pendingRows('categories')).length, 0); // 默认分类 dirty 0
});

test('上传中又改：markUploaded(旧版) 不清掉 dirty，内容是新的', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  const [sent] = await store.pendingRows('transactions');
  await store.saveTransaction({ ...input({ amountMinor: 5000 }), id: a.id });
  await store.markUploaded('transactions', [sent], [{ id: a.id, updated_at: sent.updated_at }]);
  const row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.dirty, 1);
  assert.equal(row.amount_minor, 5000);
  assert.equal((await store.pendingRows('transactions')).length, 1);
});

test('回传 updated_at 是微秒 +00:00 且较早（时钟快被压回）→ 本地写回正规化值、dirty 0、通知画面', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  const [sent] = await store.pendingRows('transactions');
  let hits = 0;
  store.subscribe(() => hits++);
  await store.markUploaded('transactions', [sent], [{ id: a.id, updated_at: '2026-11-24T05:02:09.123456+00:00' }]);
  const row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.dirty, 0);
  assert.equal(row.updated_at, '2026-11-24T05:02:09.123Z');
  assert.equal(hits, 1);
});

test('不在 returned 里（服务器 LWW 略过）→ dirty 0、updated_at 不变、不通知', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  const [sent] = await store.pendingRows('transactions');
  let hits = 0;
  store.subscribe(() => hits++);
  await store.markUploaded('transactions', [sent], []);
  const row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.dirty, 0);
  assert.equal(row.updated_at, sent.updated_at);
  assert.equal(hits, 0);
});

test('回传同一时间（只是格式不同）→ 不算改变、不通知；回传看不懂的时间 → 保留本地值', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  const b = await store.saveTransaction(input({ amountMinor: 3 }));
  const sent = await store.pendingRows('transactions');
  const sa = sent.find((r) => r.id === a.id);
  let hits = 0;
  store.subscribe(() => hits++);
  await store.markUploaded('transactions', sent, [
    { id: a.id, updated_at: sa.updated_at.replace('Z', '000+00:00') },
    { id: b.id, updated_at: 'garbage' },
  ]);
  assert.equal(hits, 0);
  assert.equal((await rowOf(db, 'transactions', a.id)).updated_at, sa.updated_at);
  assert.equal((await rowOf(db, 'transactions', b.id)).dirty, 0);
  assert.equal((await rowOf(db, 'transactions', b.id)).updated_at, sent.find((r) => r.id === b.id).updated_at);
});

test('markSyncError：pendingRows 不再包含、syncCounts.errors 1、dirty 仍 1', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  await store.saveTransaction(input({ amountMinor: 2 }));
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  assert.equal((await store.pendingRows('transactions')).length, 1);
  const row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.dirty, 1);
  assert.equal(row.sync_error.code, '23514');
  assert.equal(typeof row.sync_error.at, 'string');
  assert.deepEqual(store.syncCounts(), { pending: 1, errors: 1, txPending: 1, txErrors: 1 });
});

test('markSyncError：送出后用户又改过（updated_at 不同）→ 不标', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  await store.saveTransaction({ ...input({ amountMinor: 7 }), id: a.id });
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  assert.equal((await rowOf(db, 'transactions', a.id)).sync_error, undefined);
});

test('有 sync_error 的账被删除 / 修改 / 还原 → 清掉 sync_error、重新待上传', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  await store.deleteTransaction(a.id);
  let row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.sync_error, undefined);
  assert.equal((await store.pendingRows('transactions')).length, 1);
  await store.markSyncError('transactions', a.id, '23514', row.updated_at);
  await store.restoreTransaction(a.id);
  row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.sync_error, undefined);
  await store.markSyncError('transactions', a.id, '23514', row.updated_at);
  await store.saveTransaction({ ...input({ amountMinor: 8 }), id: a.id });
  assert.equal((await rowOf(db, 'transactions', a.id)).sync_error, undefined);
});

test('markUploaded 成功也清掉 sync_error（逐笔重试成功）', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  const sent = { ...(await rowOf(db, 'transactions', a.id)) };
  await store.markUploaded('transactions', [sent], []);
  const row = await rowOf(db, 'transactions', a.id);
  assert.equal(row.sync_error, undefined);
  assert.equal(row.dirty, 0);
});

test('clearSyncErrors：全部 sync_error 清掉、重新待上传（App 版本变了时用）', async () => {
  const { store } = await setup();
  const a = await store.saveTransaction(input());
  await store.markSyncError('transactions', a.id, '22P02', a.updated_at);
  assert.equal(await store.clearSyncErrors(), 1);
  assert.equal(store.syncCounts().errors, 0);
  assert.equal((await store.pendingRows('transactions')).length, 1);
  assert.equal(await store.clearSyncErrors(), 0);
});

test('syncCounts：两表合计；txPending 只数账目', async () => {
  const { store } = await setup();
  await store.saveTransaction(input());
  await store.saveCategory({ kind: 'expense', name: '宠物' });
  assert.deepEqual(store.syncCounts(), { pending: 2, errors: 0, txPending: 1, txErrors: 0 });
});

test('markAllForUpload：默认分类变 dirty 1、updated_at 仍 epoch；非 uuid / 大写 id 的账换 key；额外 meta 同一次写入', async () => {
  const db = createMemoryDb();
  // 旧版导入留下的怪 id
  const base = { kind: 'expense', amount_minor: 1, category_id: 'food', occurred_on: '2026-11-20', note: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', deleted: false, dirty: 0 };
  const UP = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';
  const ok = '3f2504e0-4f89-41d3-9a0c-0305e82c9999';
  await db.write({ transactions: [{ ...base, id: 'abc' }, { ...base, id: UP }, { ...base, id: ok }] });
  const { store } = await setup({ db });
  let hits = 0;
  store.subscribe(() => hits++);
  const writesBefore = db.calls.length;
  await store.markAllForUpload({ meta: { owner_user_id: 'u-1' } });
  assert.equal(db.calls.length - writesBefore, 1); // 同一次 db.write
  assert.equal(await db.getMeta('owner_user_id'), 'u-1');
  const cats = await db.getAll('categories');
  assert.ok(cats.every((c) => c.dirty === 1 && c.updated_at === DEFAULT_EPOCH));
  const txs = await db.getAll('transactions');
  assert.equal(txs.length, 3);
  assert.ok(txs.every((t) => isUuid(t.id) && t.id === t.id.toLowerCase() && t.dirty === 1));
  assert.ok(!txs.some((t) => t.id === 'abc' || t.id === UP));
  assert.ok(txs.some((t) => t.id === UP.toLowerCase()));
  assert.ok(txs.some((t) => t.id === ok && t.updated_at === base.updated_at));
  assert.equal(store.transactions().length, 3);
  assert.equal(hits, 1); // id 变了要通知画面
});

test('markAllForUpload：大写 uuid 转小写会撞到已存在的 key → 换新 uuid，不覆盖', async () => {
  const db = createMemoryDb();
  const base = { kind: 'expense', amount_minor: 1, category_id: 'food', occurred_on: '2026-11-20', note: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', deleted: false, dirty: 0 };
  const low = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  await db.write({ transactions: [{ ...base, id: low, amount_minor: 1 }, { ...base, id: low.toUpperCase(), amount_minor: 2 }] });
  const { store } = await setup({ db });
  await store.markAllForUpload();
  const txs = await db.getAll('transactions');
  assert.equal(txs.length, 2);
  assert.deepEqual(txs.map((t) => t.amount_minor).sort(), [1, 2]);
  assert.equal(txs.find((t) => t.amount_minor === 1).id, low);
  assert.ok(isUuid(txs.find((t) => t.amount_minor === 2).id));
});

test('markAllForUpload 写入失败 → 快取与 db 都不变', async () => {
  const db = createMemoryDb();
  const { store } = await setup({ db });
  db.failNextWrite(new Error('disk'));
  await assert.rejects(store.markAllForUpload({ meta: { owner_user_id: 'u-1' } }));
  assert.equal(await db.getMeta('owner_user_id'), undefined);
  assert.equal(store.syncCounts().pending, 0);
});

test('onLocalWrite：用户的写入才触发；同步方法与 setMeta 不触发', async () => {
  const { store } = await setup();
  let hits = 0;
  const off = store.onLocalWrite(() => hits++);
  const a = await store.saveTransaction(input());
  assert.equal(hits, 1);
  await store.deleteTransaction(a.id);
  await store.restoreTransaction(a.id);
  const c = await store.saveCategory({ kind: 'expense', name: '宠物' });
  await store.deleteCategory(c.id);
  const p = store.previewImport('date,kind,amount,category\r\n2026-11-01,expense,10.00,餐饮\r\n');
  await store.applyImport(p.plan);
  assert.equal(hits, 6);
  const sent = await store.pendingRows('transactions');
  await store.markUploaded('transactions', sent, []);
  await store.markSyncError('transactions', a.id, 'x', 'nope');
  await store.markAllForUpload();
  await store.clearSyncErrors();
  await store.setMeta('k', 1);
  assert.equal(hits, 6);
  off();
  await store.saveTransaction(input());
  assert.equal(hits, 6);
});

test('onLocalWrite 的监听丢错不影响写入与其他监听', async () => {
  const { store } = await setup();
  let hits = 0;
  const orig = console.error;
  console.error = () => {};
  try {
    store.onLocalWrite(() => { throw new Error('x'); });
    store.onLocalWrite(() => hits++);
    await store.saveTransaction(input());
  } finally { console.error = orig; }
  assert.equal(hits, 1);
});

test('重新 init 后 sync_error 与 dirty 都还在', async () => {
  const db = createMemoryDb();
  const { store } = await setup({ db });
  const a = await store.saveTransaction(input());
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  const { store: s2 } = await setup({ db });
  assert.deepEqual(s2.syncCounts(), { pending: 0, errors: 1, txPending: 0, txErrors: 1 });
});

// ---------- 任务 3 审核修正 ----------

test('saveTransaction 带的 id 本地找不到、又不是小写 uuid（认领换 id 后旧面板存档）→ 换新 uuid，不用怪 id 新建', async () => {
  const { store } = await setup();
  for (const odd of ['abc', '3F2504E0-4F89-41D3-9A0C-0305E82C3301']) {
    const r = await store.saveTransaction({ ...input(), id: odd });
    assert.notEqual(r.id, odd);
    assert.ok(isUuid(r.id) && r.id === r.id.toLowerCase());
  }
  const ok = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  assert.equal((await store.saveTransaction({ ...input(), id: ok })).id, ok); // 合法小写 uuid 照用（新记一笔的正常路径）
});

test('saveTransaction 本地已有的怪 id（认领前）照常更新同一笔', async () => {
  const db = createMemoryDb();
  const base = { kind: 'expense', amount_minor: 1, category_id: 'food', occurred_on: '2026-11-20', note: '', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z', deleted: false, dirty: 0 };
  await db.write({ transactions: [{ ...base, id: 'abc' }] });
  const { store } = await setup({ db });
  const r = await store.saveTransaction({ ...input({ amountMinor: 9 }), id: 'abc' });
  assert.equal(r.id, 'abc');
  assert.equal(store.transactions().length, 1);
});

test('markSyncError 没带 sentUpdatedAt → 不标', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  await store.markSyncError('transactions', a.id, '23514');
  assert.equal((await rowOf(db, 'transactions', a.id)).sync_error, undefined);
});

test('markSyncError 无动作：dirty 0 的列、不存在的 id', async () => {
  const { db, store } = await setup();
  const c = await rowOf(db, 'categories', 'food');
  await store.markSyncError('categories', 'food', '23514', c.updated_at);
  await store.markSyncError('transactions', 'nope', '23514', 'x');
  assert.equal(store.syncCounts().errors, 0);
});

test('同一毫秒（时钟不动）上传途中修改 / 删除 / 还原 → 仍待上传', async () => {
  const fixed = new Date('2026-11-25T10:00:00.000Z');
  const db = createMemoryDb();
  let n = 0;
  const store = createStore({ db, now: () => fixed, uuid: () => fakeUuid(++n) });
  await store.init();
  const a = await store.saveTransaction(input());
  for (const change of [
    () => store.saveTransaction({ ...input({ amountMinor: 2 }), id: a.id }),
    () => store.deleteTransaction(a.id),
    () => store.restoreTransaction(a.id),
  ]) {
    const [sent] = await store.pendingRows('transactions');
    await change();
    await store.markUploaded('transactions', [sent], []);
    assert.equal((await rowOf(db, 'transactions', a.id)).dirty, 1);
  }
});

test('categories 表：markUploaded、markSyncError 用文字 id；未知表名 reject', async () => {
  const { db, store } = await setup();
  const c = await store.saveCategory({ kind: 'expense', name: '宠物' });
  await store.markSyncError('categories', c.id, '23505', c.updated_at);
  assert.equal(store.syncCounts().errors, 1);
  await store.deleteCategory(c.id); // 再改 → 清掉错误
  const [sent] = await store.pendingRows('categories');
  await store.markUploaded('categories', [sent], [{ id: c.id, updated_at: sent.updated_at }]);
  assert.equal((await rowOf(db, 'categories', c.id)).dirty, 0);
  const food = await rowOf(db, 'categories', 'food');
  await store.markAllForUpload();
  const [f] = (await store.pendingRows('categories')).filter((r) => r.id === 'food');
  await store.markUploaded('categories', [f], []);
  assert.equal((await rowOf(db, 'categories', 'food')).updated_at, food.updated_at);
  await assert.rejects(store.pendingRows('nope'));
  await assert.rejects(store.markUploaded('nope', [], []));
});

test('静默方法不通知画面：markSyncError、clearSyncErrors、没换 id 的 markAllForUpload；再跑一次 markAllForUpload 0 次写入', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  let hits = 0;
  store.subscribe(() => hits++);
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  await store.clearSyncErrors();
  await store.markAllForUpload();
  assert.equal(hits, 0);
  const before = db.calls.length;
  await store.markAllForUpload();
  assert.equal(db.calls.length, before);
});

test('markUploaded：已经干净的列不重写；sent 里的 id 本地不存在 → 跳过', async () => {
  const { db, store } = await setup();
  const a = await store.saveTransaction(input());
  const [sent] = await store.pendingRows('transactions');
  await store.markUploaded('transactions', [sent], []);
  const before = db.calls.length;
  await store.markUploaded('transactions', [sent, { ...sent, id: 'ghost' }], []);
  assert.equal(db.calls.length, before);
  assert.equal((await rowOf(db, 'transactions', a.id)).dirty, 0);
});

test('markUploaded 写入失败 → 快取仍待上传', async () => {
  const { db, store } = await setup();
  await store.saveTransaction(input());
  const sent = await store.pendingRows('transactions');
  db.failNextWrite(new Error('disk'));
  await assert.rejects(store.markUploaded('transactions', sent, []));
  assert.equal(store.syncCounts().txPending, 1);
});

test('markAllForUpload 换 id 后其他栏位不变（含已删除、sync_error）', async () => {
  const db = createMemoryDb();
  const base = { kind: 'expense', amount_minor: 77, category_id: 'food', occurred_on: '2026-11-20', note: '备注', created_at: '2026-11-20T00:00:00.000Z', updated_at: '2026-11-21T00:00:00.000Z', deleted: true, dirty: 1, sync_error: { code: '22P02', at: 'x' } };
  await db.write({ transactions: [{ ...base, id: 'abc' }] });
  const { store } = await setup({ db });
  await store.markAllForUpload();
  const [t] = await db.getAll('transactions');
  const { id, ...rest } = t;
  const { ...expect } = base;
  assert.ok(isUuid(id));
  assert.deepEqual(rest, expect);
});

test('hasOwnedData：默认分类不算；有账（含已删除）或自建 / 改过的分类才算', async () => {
  const { store } = await setup();
  assert.equal(store.hasOwnedData(), false);
  const t = await store.saveTransaction(input());
  await store.deleteTransaction(t.id);
  assert.equal(store.hasOwnedData(), true);
  const { store: s2 } = await setup();
  await s2.saveCategory({ id: 'food', name: '吃饭' });
  assert.equal(s2.hasOwnedData(), true);
});

test('setMetas：一次写多个 meta 键（同一次 db.write）', async () => {
  const { db, store } = await setup();
  const before = db.calls.length;
  await store.setMetas({ a: 1, b: 2 });
  assert.equal(db.calls.length - before, 1);
  assert.equal(await store.getMeta('a'), 1);
  assert.equal(await store.getMeta('b'), 2);
});
