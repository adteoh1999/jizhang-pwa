import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTs, isUuid } from '../js/timefmt.js';

test('normalizeTs：Postgres 微秒 + +00:00 → 毫秒 Z', () => {
  assert.equal(normalizeTs('2026-11-24T05:02:09.123456+00:00'), '2026-11-24T05:02:09.123Z');
});

test('normalizeTs：一位小数、+08:00 时区', () => {
  assert.equal(normalizeTs('2026-11-24T13:02:09.1+08:00'), '2026-11-24T05:02:09.100Z');
});

test('normalizeTs：没有小数的 Z', () => {
  assert.equal(normalizeTs('2026-11-24T05:02:09Z'), '2026-11-24T05:02:09.000Z');
});

test('normalizeTs：Postgres 文字格式（空格、+00）', () => {
  assert.equal(normalizeTs('2026-11-24 05:02:09+00'), '2026-11-24T05:02:09.000Z');
});

test('normalizeTs：小数截断不进位、+0530 与负时区', () => {
  assert.equal(normalizeTs('2026-11-24T05:02:09.999999+00:00'), '2026-11-24T05:02:09.999Z');
  assert.equal(normalizeTs('2026-11-24T10:32:09+0530'), '2026-11-24T05:02:09.000Z');
  assert.equal(normalizeTs('2026-11-24T00:02:09-05:00'), '2026-11-24T05:02:09.000Z');
});

test('normalizeTs：已经是标准格式就原样', () => {
  assert.equal(normalizeTs('2026-11-24T05:02:09.123Z'), '2026-11-24T05:02:09.123Z');
});

test('normalizeTs：看不懂回 null', () => {
  for (const v of ['abc', null, undefined, '', 123, '2026-11-24', '2026-11-24T05:02:09',
    '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-11-24T25:00:00Z', '2026-11-24T05:02:09.123+00:00x']) {
    assert.equal(normalizeTs(v), null, String(v));
  }
});

test('isUuid', () => {
  assert.equal(isUuid(crypto.randomUUID()), true);
  assert.equal(isUuid('3F2504E0-4F89-11D3-9A0C-0305E82C3301'), true);
  for (const v of ['food', '', '123', null, undefined, 42, '3f2504e0-4f89-11d3-9a0c-0305e82c330', ' 3f2504e0-4f89-11d3-9a0c-0305e82c3301']) {
    assert.equal(isUuid(v), false, String(v));
  }
});
