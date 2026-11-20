import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADER, toCSV, parseCSV, planImport } from '../js/csv.js';
import { defaultCategories } from '../js/model.js';

const cats = defaultCategories();
const byId = new Map(cats.map((c) => [c.id, c]));
const now = new Date('2026-11-20T10:00:00.000Z');
let n = 0;
const uuid = () => `new-${++n}`;
const ctx = (extra = {}) => ({ existingTxs: new Map(), categories: cats, now, uuid, ...extra });
const T = (o) => ({
  id: 't1', kind: 'expense', amount_minor: 1250, category_id: 'food', occurred_on: '2026-11-20',
  note: '', created_at: '2026-11-20T01:00:00.000Z', updated_at: '2026-11-20T01:00:00.000Z',
  deleted: false, dirty: 0, ...o,
});

test('往返：中文、逗号、引号、换行', () => {
  const txs = [T({ note: '午餐, 和"老王"\n第二行' })];
  const csv = toCSV(txs, byId);
  assert.ok(csv.startsWith('﻿'));
  assert.equal(csv.split('\r\n')[0].slice(1), CSV_HEADER.join(','));
  const plan = planImport(parseCSV(csv), ctx({ existingTxs: new Map(txs.map((t) => [t.id, t])) }));
  assert.equal(plan.imported, 0);
  assert.equal(plan.skipped, 1);
  const fresh = planImport(parseCSV(csv), ctx());
  assert.equal(fresh.txs[0].note, '午餐, 和"老王"\n第二行');
  assert.equal(fresh.txs[0].amount_minor, txs[0].amount_minor);
  assert.equal(fresh.txs[0].category_id, 'food');
  assert.equal(fresh.txs[0].dirty, 1);
});

test('toCSV 跳过已删除、前后空白加引号、未知分类', () => {
  const csv = toCSV([T({ note: ' x ', category_id: 'zzz' }), T({ id: 't2', deleted: true })], byId);
  const rows = parseCSV(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][4], '未分类');
  assert.equal(rows[1][5], ' x ');
  assert.ok(csv.includes('," x ",'));
});

test('Excel 另存：CRLF、无 BOM、栏位顺序不同', () => {
  const text = 'date,amount,kind,category,note\r\n2026-11-03,12.5,expense,餐饮,早餐\r\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].amount_minor, 1250);
  assert.equal(plan.txs[0].category_id, 'food');
  assert.equal(plan.txs[0].note, '早餐');
});

test('未知分类自动新建，同名只建一个', () => {
  const text = 'date,kind,amount,category\n2026-11-01,expense,1,宠物\n2026-11-02,expense,2,宠物\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.newCategories.length, 1);
  assert.equal(plan.newCategories[0].icon, 'other');
  assert.equal(plan.newCategories[0].sort, 6);
  assert.equal(plan.txs[0].category_id, plan.txs[1].category_id);
  const inc = planImport(parseCSV('date,kind,amount,category\n2026-11-01,income,1,宠物\n'), ctx());
  assert.equal(inc.newCategories[0].icon, 'other_income');
  assert.equal(inc.newCategories[0].sort, 4);
});

test('非 MYR 与坏资料被略过', () => {
  const text = 'date,kind,amount,category,currency\n'
    + '2026-11-01,expense,5,餐饮,SGD\n'
    + '2026-11-01,expense,abc,餐饮,MYR\n'
    + '2026-02-30,expense,5,餐饮,\n'
    + '\n'
    + '2026-11-01,expense,5,餐饮,myr\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.skipped, 3);
  assert.equal(plan.imported, 1);
});

test('本地已删除的纪录会被导入恢复', () => {
  const ex = T({ deleted: true });
  const text = 'id,date,kind,amount,category,updated_at\nt1,2026-11-20,expense,12.50,餐饮,\n';
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([['t1', ex]]) }));
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].deleted, false);
  assert.equal(plan.txs[0].created_at, ex.created_at);
});

test('较新的 updated_at 覆盖已存在纪录', () => {
  const ex = T();
  const text = 'id,date,kind,amount,category,updated_at\nt1,2026-11-20,expense,20,餐饮,2026-11-21T00:00:00.000Z\n';
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([['t1', ex]]) }));
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].amount_minor, 2000);
  assert.ok(plan.txs[0].updated_at > ex.updated_at);
});

test('Excel 日期 20/11/2026 与 2026/11/5', () => {
  const text = 'date,kind,amount,category\n20/11/2026,expense,1,餐饮\n2026/11/5,expense,1,餐饮\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.txs[0].occurred_on, '2026-11-20');
  assert.equal(plan.txs[1].occurred_on, '2026-11-05');
});

test('updated_at 空白不会覆盖已存在的纪录', () => {
  const text = 'id,date,kind,amount,category,updated_at\nt1,2026-11-20,expense,20,餐饮,\n';
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([['t1', T()]]) }));
  assert.equal(plan.skipped, 1);
  assert.equal(plan.imported, 0);
});

test('新建纪录的 created_at 保留档案顺序', () => {
  const text = 'date,kind,amount,category\n2026-11-01,expense,1,餐饮\n2026-11-01,expense,2,餐饮\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.ok(plan.txs[0].created_at > plan.txs[1].created_at);
  assert.equal(plan.txs[0].created_at, now.toISOString());
});

test('缺少必要栏位丢错', () => {
  assert.throws(() => planImport([['note'], ['x']], ctx()), /缺少必要栏位/);
});

test('parseCSV：引号、空行', () => {
  assert.deepEqual(parseCSV('﻿a,"b,""c"""\n\n'), [['a', 'b,"c"']]);
  assert.deepEqual(parseCSV('a\r\nb'), [['a'], ['b']]);
});
