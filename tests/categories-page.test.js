import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCategoryName } from '../js/ui/categories-page.js';
import { exportFileName } from '../js/ui/export-csv.js';

const cats = [
  { id: 'food', name: '餐饮' },
  { id: 'c1', name: '宠物' },
];

test('checkCategoryName：空白 → 请输入名称', () => {
  assert.equal(checkCategoryName('', cats, null), '请输入名称');
  assert.equal(checkCategoryName('   ', cats, null), '请输入名称');
});

test('checkCategoryName：超过 30 字 → 名称最多 30 字；刚好 30 字可以', () => {
  assert.equal(checkCategoryName('字'.repeat(31), cats, null), '名称最多 30 字');
  assert.equal(checkCategoryName('字'.repeat(30), cats, null), null);
  assert.equal(checkCategoryName(`  ${'字'.repeat(30)}  `, cats, null), null); // 前后空白不算
});

test('checkCategoryName：同类型已有同名（去掉前后空白比较）→ 已经有这个分类', () => {
  assert.equal(checkCategoryName('宠物', cats, null), '已经有这个分类');
  assert.equal(checkCategoryName(' 餐饮 ', cats, null), '已经有这个分类');
});

test('checkCategoryName：编辑时名称不变不算重复', () => {
  assert.equal(checkCategoryName('宠物', cats, 'c1'), null);
  assert.equal(checkCategoryName('餐饮', cats, 'c1'), '已经有这个分类');
});

test('exportFileName：用当地日期 jizhang-YYYYMMDD.csv', () => {
  assert.equal(exportFileName(new Date(2026, 0, 5, 23, 59)), 'jizhang-20260105.csv');
  assert.equal(exportFileName(new Date(2026, 10, 20, 0, 1)), 'jizhang-20261120.csv');
});
