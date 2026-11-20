import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_NAMES, ICON_DATA, CATEGORY_ICON_CHOICES } from '../js/ui/icons.js';

const REQUIRED = [
  'food', 'transport', 'shopping', 'bills', 'fun', 'other',
  'salary', 'bonus', 'side', 'other_income',
  'pet', 'health', 'home', 'gift', 'travel', 'education', 'coffee', 'phone',
  'house', 'chart', 'gear', 'plus', 'chevron-left', 'chevron-right', 'trash', 'share', 'square-arrow-up',
];

test('all required icon names exist', () => {
  for (const n of REQUIRED) assert.ok(ICON_NAMES.includes(n), `missing ${n}`);
});

test('CATEGORY_ICON_CHOICES has 18 entries, all defined, in order', () => {
  assert.equal(CATEGORY_ICON_CHOICES.length, 18);
  assert.deepEqual(CATEGORY_ICON_CHOICES, REQUIRED.slice(0, 18));
  for (const n of CATEGORY_ICON_CHOICES) assert.ok(ICON_NAMES.includes(n));
});

test('every path string is non-empty and only has path commands and numbers', () => {
  for (const name of ICON_NAMES) {
    const paths = ICON_DATA[name];
    assert.ok(Array.isArray(paths) && paths.length > 0, name);
    for (const d of paths) {
      assert.equal(typeof d, 'string');
      assert.ok(d.trim().length > 0, name);
      assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/, name);
      assert.match(d.trim(), /^[Mm]/, name);
    }
  }
});
