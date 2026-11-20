import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EPOCH, DEFAULT_CATEGORIES, defaultCategories, timeValue, NOTE_MAX,
  CATEGORY_NAME_MAX, nextUpdatedAt, ValidationError, buildTransaction,
  buildCategory, markDeleted, markRestored,
} from '../js/model.js';

const now = new Date('2026-11-20T09:00:00.000Z');
let n = 0;
const deps = { now, uuid: () => `u${++n}` };
const base = { kind: 'expense', amountMinor: 1250, categoryId: 'food', occurredOn: '2026-11-20', note: ' lunch ' };
const fieldOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ValidationError); return e.field; } return null; };

test('default categories', () => {
  assert.equal(DEFAULT_CATEGORIES.length, 10);
  const names = Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c.id, c.name]));
  assert.deepEqual(names, { food: '餐饮', transport: '交通', shopping: '购物', bills: '账单', fun: '娱乐', other: '其他',
    salary: '工资', bonus: '奖金', side: '副业', other_income: '其他收入' });
  const exp = DEFAULT_CATEGORIES.filter((c) => c.kind === 'expense');
  const inc = DEFAULT_CATEGORIES.filter((c) => c.kind === 'income');
  assert.deepEqual(exp.map((c) => c.sort), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(inc.map((c) => c.sort), [0, 1, 2, 3]);
  for (const c of DEFAULT_CATEGORIES) {
    assert.equal(c.updated_at, DEFAULT_EPOCH);
    assert.equal(c.icon, c.id);
    assert.equal(c.deleted, false);
    assert.equal(c.dirty, 0);
  }
});

test('DEFAULT_CATEGORIES frozen; defaultCategories returns fresh copies', () => {
  assert.ok(Object.isFrozen(DEFAULT_CATEGORIES));
  assert.ok(DEFAULT_CATEGORIES.every(Object.isFrozen));
  const a = defaultCategories();
  a[0].name = 'x'; a.pop();
  const b = defaultCategories();
  assert.equal(b.length, 10);
  assert.equal(b[0].name, '餐饮');
  assert.notEqual(a[0], DEFAULT_CATEGORIES[0]);
});

test('timeValue / nextUpdatedAt', () => {
  assert.equal(timeValue('坏掉'), -Infinity);
  assert.equal(timeValue(undefined), -Infinity);
  assert.equal(timeValue('2026-11-20T10:00:00.000Z'), Date.parse('2026-11-20T10:00:00.000Z'));
  assert.equal(nextUpdatedAt('2026-11-20T10:00:00.000Z', now), '2026-11-20T10:00:00.001Z');
  assert.equal(nextUpdatedAt('坏掉', now), now.toISOString());
  assert.equal(nextUpdatedAt(undefined, now), now.toISOString());
  assert.equal(nextUpdatedAt('2026-11-20T08:00:00.000Z', now), now.toISOString());
});

test('buildTransaction new', () => {
  const t = buildTransaction(base, undefined, deps);
  assert.match(t.id, /^u\d+$/);
  assert.equal(t.note, 'lunch');
  assert.equal(t.amount_minor, 1250);
  assert.equal(t.category_id, 'food');
  assert.equal(t.occurred_on, '2026-11-20');
  assert.equal(t.created_at, now.toISOString());
  assert.equal(t.updated_at, now.toISOString());
  assert.equal(t.deleted, false);
  assert.equal(t.dirty, 1);
  assert.equal(buildTransaction({ ...base, note: undefined }, undefined, deps).note, '');
});

test('buildTransaction uses input.id without existing', () => {
  const t = buildTransaction({ ...base, id: 'abc' }, undefined, deps);
  assert.equal(t.id, 'abc');
  assert.equal(t.created_at, now.toISOString());
});

test('buildTransaction edit keeps id and created_at', () => {
  const ex = { id: 'e1', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-11-20T09:00:00.000Z', deleted: true, dirty: 0 };
  const t = buildTransaction({ ...base, id: 'other' }, ex, deps);
  assert.equal(t.id, 'e1');
  assert.equal(t.created_at, ex.created_at);
  assert.ok(timeValue(t.updated_at) > timeValue(ex.updated_at));
  assert.equal(t.deleted, false);
  assert.equal(t.dirty, 1);
});

test('buildTransaction validation', () => {
  const f = (o) => fieldOf(() => buildTransaction({ ...base, ...o }, undefined, deps));
  assert.equal(f({ kind: 'x' }), 'kind');
  assert.equal(f({ amountMinor: 0 }), 'amount');
  assert.equal(f({ amountMinor: 1.5 }), 'amount');
  assert.equal(f({ amountMinor: '5' }), 'amount');
  assert.equal(f({ amountMinor: 10000000000 }), 'amount');
  assert.equal(f({ amountMinor: 9999999999 }), null);
  assert.equal(f({ occurredOn: '2026-02-30' }), 'date');
  assert.equal(f({ categoryId: '' }), 'category');
  assert.equal(f({ categoryId: undefined }), 'category');
  assert.equal(f({ note: 'a'.repeat(NOTE_MAX + 1) }), 'note');
  assert.equal(f({ note: 'a'.repeat(NOTE_MAX) }), null);
  assert.equal(f({ note: ' ' + 'a'.repeat(NOTE_MAX) + ' ' }), null);
});

test('buildCategory', () => {
  const c = buildCategory({ kind: 'income', name: ' 兼职 ', icon: 'star', sort: 4 }, undefined, deps);
  assert.deepEqual(c, { id: c.id, kind: 'income', name: '兼职', icon: 'star', sort: 4,
    updated_at: now.toISOString(), deleted: false, dirty: 1 });
  assert.equal(buildCategory({ id: 'cid', kind: 'expense', name: 'a', icon: 'x', sort: 0 }, undefined, deps).id, 'cid');
  assert.equal(buildCategory({ kind: 'expense', name: 'a', sort: 0 }, undefined, deps).icon, 'other');
  assert.equal(buildCategory({ kind: 'income', name: 'a', icon: '', sort: 0 }, undefined, deps).icon, 'other_income');
  assert.equal(buildCategory({ kind: 'income', name: 'a', icon: 'x'.repeat(31), sort: 0 }, undefined, deps).icon, 'other_income');
  const f = (o) => fieldOf(() => buildCategory({ kind: 'expense', name: 'a', icon: 'x', sort: 0, ...o }, undefined, deps));
  assert.equal(f({ name: '   ' }), 'name');
  assert.equal(f({ name: 'a'.repeat(CATEGORY_NAME_MAX + 1) }), 'name');
  assert.equal(f({ name: 'a'.repeat(CATEGORY_NAME_MAX) }), null);
  assert.equal(f({ kind: 'zzz' }), 'kind');
});

test('buildCategory edit keeps id and kind', () => {
  const ex = { id: 'food', kind: 'expense', name: '餐饮', icon: 'food', sort: 0, updated_at: DEFAULT_EPOCH, deleted: false, dirty: 0 };
  const c = buildCategory({ kind: 'income', name: '吃喝', icon: 'food', sort: 0 }, ex, deps);
  assert.equal(c.id, 'food');
  assert.equal(c.kind, 'expense');
  assert.equal(c.name, '吃喝');
  assert.equal(c.dirty, 1);
  assert.ok(timeValue(c.updated_at) > timeValue(DEFAULT_EPOCH));
});

test('markDeleted / markRestored return new objects', () => {
  const rec = { id: 'a', deleted: false, dirty: 0, updated_at: '2026-11-20T10:00:00.000Z' };
  const snapshot = { ...rec };
  const d = markDeleted(rec, now);
  assert.deepEqual(rec, snapshot);
  assert.notEqual(d, rec);
  assert.equal(d.deleted, true);
  assert.equal(d.dirty, 1);
  assert.equal(d.updated_at, '2026-11-20T10:00:00.001Z');
  const r = markRestored(d, now);
  assert.equal(d.deleted, true);
  assert.equal(r.deleted, false);
  assert.equal(r.dirty, 1);
  assert.equal(r.updated_at, '2026-11-20T10:00:00.002Z');
});
