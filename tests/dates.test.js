import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLocalDateString, todayLocal, monthOf, shiftMonth, formatMonthTitle, formatDayHeader, isValidDateString } from '../js/dates.js';

test('晚上 11 点记账仍是当地当天', () => {
  const d = new Date(2026, 10, 20, 23, 30);
  assert.equal(toLocalDateString(d), '2026-11-20');
  assert.equal(todayLocal(new Date(2026, 10, 21, 0, 5)), '2026-11-21');
});
test('monthOf', () => {
  assert.equal(monthOf('2026-11-20'), '2026-11');
});
test('shiftMonth 跨年', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});
test('isValidDateString', () => {
  assert.ok(isValidDateString('2028-02-29'));
  assert.ok(!isValidDateString('2026-02-29'));
  assert.ok(!isValidDateString('2026-02-30'));
  assert.ok(!isValidDateString('2026-2-3'));
});
test('formatDayHeader', () => {
  assert.equal(formatDayHeader('2026-11-20', '2026-11-20'), '今天');
  assert.equal(formatDayHeader('2026-11-19', '2026-11-20'), '昨天');
  assert.equal(formatDayHeader('2026-11-18', '2026-11-20'), '11月18日 周三');
  assert.equal(formatDayHeader('2025-12-31', '2026-11-20'), '2025年12月31日 周三');
  assert.equal(formatMonthTitle('2026-11'), '2026 年 11 月');
});
test('formatDayHeader 昨天跨月/跨年', () => {
  assert.equal(formatDayHeader('2026-02-28', '2026-03-01'), '昨天');
  assert.equal(formatDayHeader('2025-12-31', '2026-01-01'), '昨天');
});
