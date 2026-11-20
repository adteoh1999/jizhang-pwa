import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceSizeClass, balanceParts, rowIconAttr } from '../js/ui/home.js';

test('balanceSizeClass', () => {
  assert.equal(balanceSizeClass(123450), '');        // 1,234
  assert.equal(balanceSizeClass(-123450), '');
  assert.equal(balanceSizeClass(123456700), 'is-long');   // 1,234,567
  assert.equal(balanceSizeClass(999999999900), 'is-xlong'); // 9,999,999,999
});

test('balanceSizeClass 边界：6 / 7 / 9 / 10 字元', () => {
  assert.equal(balanceSizeClass(0), '');                 // 0
  assert.equal(balanceSizeClass(9999999), '');           // 99,999（6）
  assert.equal(balanceSizeClass(10000000), 'is-long');   // 100,000（7）
  assert.equal(balanceSizeClass(-10000000), 'is-long');
  assert.equal(balanceSizeClass(999999900), 'is-long');     // 9,999,999（9）
  assert.equal(balanceSizeClass(1000000000), 'is-xlong');   // 10,000,000（10）
});

test('balanceParts：RM / 整数 / .角，负数整数前加 U+2212', () => {
  assert.deepEqual(balanceParts(123450), { int: '1,234', dec: '.50' });
  assert.deepEqual(balanceParts(-5), { int: '−0', dec: '.05' });
  assert.deepEqual(balanceParts(0), { int: '0', dec: '.00' });
});

test('rowIconAttr：有效分类 → iconKey；已删除 / 未分类 → null', () => {
  assert.equal(rowIconAttr({ icon: 'food', deleted: false }), 'food');
  assert.equal(rowIconAttr({ icon: 'not-a-real-icon', deleted: false }), 'other');
  assert.equal(rowIconAttr({ icon: 'food', deleted: true }), null);
  assert.equal(rowIconAttr(null), null);
  assert.equal(rowIconAttr(undefined), null);
});

test('CSS：增加对比度 / 降低透明度时拿掉结余卡光晕', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const i = css.indexOf('@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {');
  assert.ok(i >= 0);
  const block = css.slice(i, css.indexOf('\n}', i));
  assert.match(block, /\.home-card::before\s*\{\s*display:\s*none;/);
});
