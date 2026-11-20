import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMonth, byCategory, groupByDate } from '../js/stats.js';

const T = (id, kind, amt, cat, day, created = '2026-11-01T00:00:00.000Z') => ({
  id, kind, amount_minor: amt, category_id: cat, occurred_on: day, note: '',
  created_at: created, updated_at: created, deleted: false, dirty: 0,
});
const txs = [
  T('a', 'expense', 1000, 'food', '2026-11-20', '2026-11-20T08:00:00.000Z'),
  T('b', 'expense', 2000, 'transport', '2026-11-20', '2026-11-20T09:00:00.000Z'),
  T('d', 'income', 50000, 'salary', '2026-11-20', '2026-11-20T09:00:00.000Z'),
  T('c', 'expense', 3000, 'food', '2026-11-05'),
  T('e', 'expense', 700, 'fun', '2026-10-31'),
];

test('summarizeMonth', () => {
  assert.deepEqual(summarizeMonth(txs, '2026-11'), { income: 50000, expense: 6000, balance: 44000 });
  assert.deepEqual(summarizeMonth(txs, '2026-10'), { income: 0, expense: 700, balance: -700 });
  assert.deepEqual(summarizeMonth(txs, '2026-09'), { income: 0, expense: 0, balance: 0 });
});

test('byCategory 排序与 ratio', () => {
  const r = byCategory(txs, '2026-11', 'expense');
  assert.deepEqual(r.map((x) => x.category_id), ['food', 'transport']);
  assert.equal(r[0].total, 4000);
  assert.ok(Math.abs(r.reduce((s, x) => s + x.ratio, 0) - 1) < 1e-9);
  assert.ok(Math.abs(r[0].ratio - 4000 / 6000) < 1e-9);
  assert.deepEqual(byCategory(txs, '2026-09', 'expense'), []);
  assert.deepEqual(byCategory(txs, '2026-10', 'income'), []);
});

test('groupByDate 顺序与 net，同 created_at 依 id', () => {
  const g = groupByDate(txs);
  assert.deepEqual(g.map((x) => x.date), ['2026-11-20', '2026-11-05', '2026-10-31']);
  assert.deepEqual(g[0].items.map((x) => x.id), ['b', 'd', 'a']);
  assert.equal(g[0].net, 50000 - 3000);
  assert.equal(g[1].net, -3000);
  assert.deepEqual(groupByDate([]), []);
});
