import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceSizeClass, balanceParts, meterText, countText, flowSizeClass,
} from '../js/ui/home.js';
import { rowIconAttr } from '../js/ui/icons.js';

test('balanceSizeClass：整数部分字元数（含 U+2212 与逗号）≤5 / 6–9 / ≥10', () => {
  assert.equal(balanceSizeClass(123450), '');               // 1,234
  assert.equal(balanceSizeClass(-123450), 'is-long');       // −1,234
  assert.equal(balanceSizeClass(1234567), 'is-long');       // 12,345
  assert.equal(balanceSizeClass(123456700), 'is-long');     // 1,234,567
  assert.equal(balanceSizeClass(999999999900), 'is-xlong'); // 9,999,999,999
});

test('balanceSizeClass 边界', () => {
  assert.equal(balanceSizeClass(0), '');                  // 0
  assert.equal(balanceSizeClass(999999), '');             // 9,999（5）
  assert.equal(balanceSizeClass(-99999), '');             // −999（4）
  assert.equal(balanceSizeClass(1000000), 'is-long');     // 10,000（6）
  assert.equal(balanceSizeClass(-999999), 'is-long');     // −9,999（6）
  assert.equal(balanceSizeClass(999999900), 'is-long');   // 9,999,999（9）
  assert.equal(balanceSizeClass(1000000000), 'is-xlong'); // 10,000,000（10）
  assert.equal(balanceSizeClass(-100000000), 'is-xlong'); // −1,000,000（10）
});

test('meterText：三种状态的逐字文案', () => {
  assert.equal(meterText({ state: 'ratio', pct: 68 }), '已花掉收入的 68%');
  assert.equal(meterText({ state: 'ratio', pct: 0 }), '已花掉收入的 0%');
  assert.equal(meterText({ state: 'over', pct: 100 }), '支出已超过收入');
  assert.equal(meterText({ state: 'none', pct: 0 }), '本月还没有收入');
});

test('countText：共 N 笔', () => {
  assert.equal(countText(0), '共 0 笔');
  assert.equal(countText(230), '共 230 笔');
});

test('flowSizeClass：收入 / 支出金额字串 ≥13 字元缩一级', () => {
  assert.equal(flowSizeClass(9999999), '');          // RM 99,999.99（12）
  assert.equal(flowSizeClass(99999999), 'is-small'); // RM 999,999.99（13）
  assert.equal(flowSizeClass(10002345599), 'is-small');
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

test('CSS：大标题列允许换行（大字级时月份换到下一行，不挤压「记账」）', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const i = css.indexOf('.large-title-row {');
  assert.ok(i >= 0);
  assert.match(css.slice(i, css.indexOf('}', i)), /flex-wrap:\s*wrap/);
});
