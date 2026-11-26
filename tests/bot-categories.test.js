// 3d Task 2：bot 用的内建分类（必须与 App 的 js/model.js 相同）＋合并服务器分类
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOT_DEFAULT_CATEGORIES, botMergeCategories } from '../supabase/functions/_shared/bot-categories.ts';
import { DEFAULT_CATEGORIES } from '../js/model.js';
import { SHARED_IMPORT_FORBIDDEN } from '../scripts/build-functions.mjs';

const pick = (c) => ({ id: c.id, kind: c.kind, name: c.name, sort: c.sort });

test('内建分类与 App 的 DEFAULT_CATEGORIES 完全相同（改一边忘了另一边会失败）', () => {
  assert.deepEqual(BOT_DEFAULT_CATEGORIES.map(pick), DEFAULT_CATEGORIES.map(pick));
});

test('_shared/bot-categories.ts 不 import 别的档（打包规则）', () => {
  const src = readFileSync(new URL('../supabase/functions/_shared/bot-categories.ts', import.meta.url), 'utf8');
  assert.equal(SHARED_IMPORT_FORBIDDEN.test(src), false);
});

test('服务器没有分类 → 就是内建的，支出在前、各自按 sort', () => {
  const got = botMergeCategories([]);
  assert.deepEqual(got.map((c) => c.id),
    ['food', 'transport', 'shopping', 'bills', 'fun', 'other', 'salary', 'bonus', 'side', 'other_income']);
});

test('服务器同 id 的列盖过内建（改名）', () => {
  const got = botMergeCategories([{ id: 'food', kind: 'expense', name: '吃饭', sort: 0, deleted: false }]);
  assert.equal(got.find((c) => c.id === 'food').name, '吃饭');
  assert.equal(got.length, 10);
});

test('服务器标记删除的内建分类会被拿掉', () => {
  const got = botMergeCategories([{ id: 'fun', kind: 'expense', name: '娱乐', sort: 4, deleted: true }]);
  assert.equal(got.some((c) => c.id === 'fun'), false);
  assert.equal(got.length, 9);
});

test('服务器的自订分类加进来，按 sort 再按 id 排', () => {
  const got = botMergeCategories([
    { id: 'pet', kind: 'expense', name: '宠物', sort: 2, deleted: false },
    { id: 'gift', kind: 'income', name: '红包', sort: 9, deleted: false },
  ]);
  const exp = got.filter((c) => c.kind === 'expense').map((c) => c.id);
  assert.deepEqual(exp, ['food', 'transport', 'pet', 'shopping', 'bills', 'fun', 'other']);
  assert.equal(got[got.length - 1].id, 'gift');
});

test('坏资料不 throw：不是阵列 → 内建；坏列跳过', () => {
  assert.equal(botMergeCategories(null).length, 10);
  assert.equal(botMergeCategories('x').length, 10);
  const got = botMergeCategories([
    null, 'food', { id: '', kind: 'expense', name: 'x', sort: 0 }, { id: 'a', kind: 'gift', name: 'x', sort: 0 },
    { id: 'b', kind: 'expense', name: '', sort: 0 }, { id: 'c', kind: 'expense', name: 'x', sort: 'z' },
    { id: 'x'.repeat(65), kind: 'expense', name: 'x', sort: 0 },
  ]);
  assert.equal(got.length, 10);
});

test('回传的是新物件：改它不会改到内建清单', () => {
  const got = botMergeCategories([]);
  got[0].name = '乱改';
  assert.equal(BOT_DEFAULT_CATEGORIES[0].name, '餐饮');
});
