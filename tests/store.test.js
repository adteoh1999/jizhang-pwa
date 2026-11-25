import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { ValidationError, timeValue } from '../js/model.js';

// 合法 uuid 格式（CSV 导入只认 uuid）
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = () => new Date('2026-11-20T10:00:00.000Z');
async function setup() {
  let n = 0;
  const db = createMemoryDb();
  const store = createStore({ db, now, uuid: () => fakeUuid(++n) });
  await store.init();
  return { db, store };
}
const input = (o = {}) => ({ kind: 'expense', amountMinor: 1250, categoryId: 'food', occurredOn: '2026-11-20', note: '', ...o });

test('init 建默认分类且不重复', async () => {
  const { store } = await setup();
  assert.equal(store.categories('expense').length, 6);
  assert.equal(store.categories('income').length, 4);
  await store.init();
  assert.equal(store.categories('expense').length, 6);
});

test('存一笔：dirty=1、订阅通知 1 次', async () => {
  const { db, store } = await setup();
  let hits = 0;
  store.subscribe(() => hits++);
  await store.saveTransaction(input());
  assert.equal(store.transactions().length, 1);
  assert.equal((await db.getAll('transactions'))[0].dirty, 1);
  assert.equal(hits, 1);
});

test('删除与还原', async () => {
  const { db, store } = await setup();
  const t = await store.saveTransaction(input());
  await store.deleteTransaction(t.id);
  assert.equal(store.transactions().length, 0);
  assert.equal((await db.getAll('transactions'))[0].deleted, true);
  await store.restoreTransaction(t.id);
  assert.equal(store.transactions().length, 1);
  await assert.rejects(store.deleteTransaction('nope'), /找不到这笔记录/);
});

test('重复删除不写入也不通知', async () => {
  const { db, store } = await setup();
  const t = await store.saveTransaction(input());
  await store.deleteTransaction(t.id);
  const calls = db.calls.length;
  let hits = 0;
  store.subscribe(() => hits++);
  await store.deleteTransaction(t.id);
  assert.equal(db.calls.length, calls);
  assert.equal(hits, 0);
});

test('删分类后旧账单仍在、名称可查', async () => {
  const { store } = await setup();
  await store.saveTransaction(input());
  await store.deleteCategory('food');
  assert.ok(!store.categories('expense').some((c) => c.id === 'food'));
  assert.equal(store.categoryById('food').name, '餐饮');
  assert.equal(store.transactions().length, 1);
  // 旧账单用已删分类仍可编辑
  const t = store.transactions()[0];
  await store.saveTransaction(input({ id: t.id, amountMinor: 300 }));
  await assert.rejects(store.deleteCategory('nope'), /找不到这个分类/);
});

test('分类 kind 不符或不存在 → ValidationError category', async () => {
  const { store } = await setup();
  await assert.rejects(store.saveTransaction(input({ categoryId: 'salary' })), (e) => e instanceof ValidationError && e.field === 'category');
  await assert.rejects(store.saveTransaction(input({ categoryId: 'zzz' })), (e) => e.field === 'category');
});

test('write 失败：reject、快取不变、后续写入照常', async () => {
  const { db, store } = await setup();
  let hits = 0;
  store.subscribe(() => hits++);
  db.failNextWrite(new Error('quota'));
  await assert.rejects(store.saveTransaction(input()), /quota/);
  assert.equal(store.transactions().length, 0);
  assert.equal(hits, 0);
  await store.saveTransaction(input());
  assert.equal(store.transactions().length, 1);
});

test('同 id 连续 save 两次（不 await）只有一笔，created_at 不变', async () => {
  let t = Date.parse('2026-11-20T10:00:00.000Z');
  const db = createMemoryDb();
  let n = 0;
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  const p1 = store.saveTransaction(input({ id: 'x' }));
  const p2 = store.saveTransaction(input({ id: 'x', amountMinor: 500 }));
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(store.transactions().length, 1);
  assert.equal((await db.getAll('transactions')).length, 1);
  assert.equal(b.created_at, a.created_at);
  assert.ok(timeValue(b.updated_at) > timeValue(a.updated_at));
  assert.equal(store.transactions()[0].amount_minor, 500);
});

test('save 已删除纪录的 id 会复活它', async () => {
  const { store } = await setup();
  const t = await store.saveTransaction(input({ id: 'r' }));
  await store.deleteTransaction(t.id);
  const r = await store.saveTransaction(input({ id: 'r', amountMinor: 700 }));
  assert.equal(r.deleted, false);
  assert.equal(store.transactions().length, 1);
});

test('restoreTransaction 找不到 id → 抛错', async () => {
  const { store } = await setup();
  await assert.rejects(store.restoreTransaction('nope'), /找不到这笔记录/);
});

test('setMeta 不通知订阅者', async () => {
  const { store } = await setup();
  let hits = 0;
  store.subscribe(() => hits++);
  await store.setMeta('k', 1);
  assert.equal(hits, 0);
});

test('init 与 save 并发：快取仍含已存的纪录', async () => {
  const { store } = await setup();
  const p = store.saveTransaction(input({ id: 'c' }));
  const q = store.init();
  await Promise.all([p, q]);
  assert.equal(store.transactions().length, 1);
});

test('applyImport 后改动 plan 不影响快取', async () => {
  const { store } = await setup();
  const p = store.previewImport('date,kind,amount,category\r\n2026-11-01,expense,10.00,餐饮\r\n');
  await store.applyImport(p.plan);
  p.plan.txs[0].note = 'hacked';
  assert.equal(store.transactions()[0].note, '');
});

test('transactions() 回传的对象不能改动快取', async () => {
  const { store } = await setup();
  await store.saveTransaction(input());
  const t = store.transactions()[0];
  assert.throws(() => { 'use strict'; t.amount_minor = 1; });
  assert.equal(store.transactions()[0].amount_minor, 1250);
});

test('saveCategory：新分类 sort 取同 kind 最大 +1（含已删除）', async () => {
  const { store } = await setup();
  await store.deleteCategory('other');
  const c = await store.saveCategory({ kind: 'expense', name: '宠物', icon: 'other' });
  assert.equal(c.sort, 6);
  const e = await store.saveCategory({ id: c.id, kind: 'expense', name: '宠物店', icon: 'other' });
  assert.equal(e.sort, 6);
  assert.equal(e.name, '宠物店');
});

test('meta 读写', async () => {
  const { store } = await setup();
  assert.equal(await store.getMeta('k'), undefined);
  await store.setMeta('k', { a: 1 });
  assert.deepEqual(await store.getMeta('k'), { a: 1 });
});

test('订阅：listener 抛错不影响 store；可取消', async () => {
  const { store } = await setup();
  const origErr = console.error; console.error = () => {};
  let hits = 0;
  try {
    store.subscribe(() => { throw new Error('boom'); });
    const off = store.subscribe(() => hits++);
    await store.saveTransaction(input());
    off();
    await store.saveTransaction(input());
  } finally { console.error = origErr; }
  assert.equal(hits, 1);
  assert.equal(store.transactions().length, 2);
});

test('previewImport(exportCSV()) → imported 0、skipped N；坏格式 throw', async () => {
  const { store } = await setup();
  await store.saveTransaction(input());
  await store.saveTransaction(input({ amountMinor: 99 }));
  const p = store.previewImport(store.exportCSV());
  assert.equal(p.imported, 0);
  assert.equal(p.skipped, 2);
  assert.equal(p.newCategoryCount, 0);
  assert.throws(() => store.previewImport('a,b\r\n1,2'), /CSV 格式不对/);
});

test('导入建新分类：分类与账单同一次 db.write', async () => {
  const { db, store } = await setup();
  const csv = 'date,kind,amount,category\r\n2026-11-01,expense,10.00,猫粮\r\n';
  const p = store.previewImport(csv);
  assert.equal(p.newCategoryCount, 1);
  assert.equal(db.calls.length, 1); // 只有 init 的默认分类，预览不写入
  const r = await store.applyImport(p.plan);
  assert.deepEqual(r, { imported: 1, skipped: 0 });
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[1].sort(), ['categories', 'transactions']);
  assert.equal(store.transactions().length, 1);
  await store.applyImport({ txs: [], newCategories: [], imported: 0, skipped: 3 });
  assert.equal(db.calls.length, 2);
});

test('exportCSV 含已删分类名称', async () => {
  const { store } = await setup();
  await store.saveTransaction(input());
  await store.deleteCategory('food');
  assert.match(store.exportCSV(), /餐饮/);
});

test('db.js 可在 Node 载入', async () => {
  const m = await import('../js/db.js');
  assert.equal(typeof m.openDatabase, 'function');
});
