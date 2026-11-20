import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMonth, byCategory, groupByDate, spendMeter, cumulativeByDay } from '../js/stats.js';

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

test('groupByDate 同日 created_at 用时间数值比较（不同格式）', () => {
  const a = T('a', 'expense', 1, 'food', '2026-11-20', '2026-11-20T10:00:00.000Z');
  const b = T('b', 'expense', 1, 'food', '2026-11-20', '2026-11-20T18:30:00+08:00');
  assert.deepEqual(groupByDate([a, b])[0].items.map((x) => x.id), ['b', 'a']);
});

test('groupByDate created_at 字串顺序与时间顺序不一致时以时间为准', () => {
  const c = T('c', 'expense', 1, 'food', '2026-11-20', '2026-11-20T18:30:00+08:00'); // 10:30Z
  const d = T('d', 'expense', 1, 'food', '2026-11-20', '2026-11-20T12:00:00.000Z');
  assert.deepEqual(groupByDate([c, d])[0].items.map((x) => x.id), ['d', 'c']);
});

test('spendMeter', () => {
  assert.deepEqual(spendMeter(0, 0), { state: 'none', pct: 0 });
  assert.deepEqual(spendMeter(0, 500), { state: 'none', pct: 0 });
  assert.deepEqual(spendMeter(380000, 256550), { state: 'ratio', pct: 68 });
  assert.deepEqual(spendMeter(1000, 1000), { state: 'ratio', pct: 100 });
  assert.deepEqual(spendMeter(1000, 1001), { state: 'over', pct: 100 });
  assert.deepEqual(spendMeter(100000, 1), { state: 'ratio', pct: 0 });
});

const tx = (occurred_on, kind, amount_minor) => ({
  id: `${occurred_on}-${kind}-${amount_minor}`, occurred_on, kind, amount_minor, category_id: 'food',
  deleted: false, created_at: '2026-11-01T00:00:00.000Z',
});

test('cumulativeByDay current month stops at today', () => {
  const txs = [tx('2026-11-02', 'expense', 4590), tx('2026-11-05', 'expense', 12800),
               tx('2026-11-05', 'income', 12000), tx('2026-10-31', 'expense', 999)];
  const v = cumulativeByDay(txs, '2026-11', 'expense', '2026-11-20');
  assert.equal(v.length, 30);
  assert.equal(v[0], 0); assert.equal(v[1], 4590); assert.equal(v[4], 17390); assert.equal(v[19], 17390);
  assert.equal(v[20], null); assert.equal(v[29], null);
});

test('cumulativeByDay past month is complete', () => {
  const v = cumulativeByDay([], '2026-02', 'income', '2026-11-20');
  assert.equal(v.length, 28); assert.ok(v.every((x) => x === 0));
});

test('cumulativeByDay first of month, leap year, month lengths, income kind', () => {
  const one = cumulativeByDay([tx('2026-12-01', 'expense', 500)], '2026-12', 'expense', '2026-12-01');
  assert.equal(one.length, 31);
  assert.equal(one[0], 500);
  assert.equal(one.filter((x) => x !== null).length, 1);
  assert.equal(cumulativeByDay([], '2028-02', 'expense', '2028-03-01').length, 29);
  const inc = cumulativeByDay([tx('2026-10-31', 'income', 700), tx('2026-10-01', 'income', 300),
    tx('2026-10-15', 'expense', 999)], '2026-10', 'income', '2026-11-20');
  assert.equal(inc[0], 300); assert.equal(inc[29], 300); assert.equal(inc[30], 1000);
  assert.ok(cumulativeByDay([], '2026-12', 'expense', '2026-11-20').every((x) => x === null)); // 未来月份
});
