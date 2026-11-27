// 3e：bot 用用户关键词决定分类（一定优先于 AI）。纯函数：解析服务器回传、比对、套用。
// 规则（用户 2026-11-27）：不分大小写、包含即对上；英文／数字那一端要整个词；最长者胜（同长按字串顺序）；
// 收支相同才套用；分类已删除／不存在跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { botParseKeywords, botKeywordHits, botApplyKeyword } from '../supabase/functions/_shared/bot-keywords.ts';
import { normalizeKeyword } from '../js/model.js';
import { SHARED_IMPORT_FORBIDDEN } from '../scripts/build-functions.mjs';

const CATS = [
  { id: 'food', kind: 'expense' }, { id: 'transport', kind: 'expense' }, { id: 'shopping', kind: 'expense' },
  { id: 'salary', kind: 'income' }, { id: 'side', kind: 'income' },
];
const draft = (over = {}) => ({ kind: 'expense', amountMinor: 1250, categoryId: 'food', occurredOn: '2026-11-27', note: '', ...over });
const kw = (keyword, categoryId) => ({ keyword, categoryId });

test('_shared/bot-keywords.ts 不 import 别的档（打包规则）', () => {
  const src = readFileSync(new URL('../supabase/functions/_shared/bot-keywords.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, SHARED_IMPORT_FORBIDDEN);
});

test('botParseKeywords：坏列跳过、保留服务器原字串（不因正规化不同而丢）、最多 500 个', () => {
  assert.deepEqual(botParseKeywords(null), []);
  assert.deepEqual(botParseKeywords('x'), []);
  assert.deepEqual(botParseKeywords([
    { keyword: 'grab', category_id: 'transport' }, { keyword: 'Straße', category_id: 'food' },
    { keyword: '', category_id: 'food' }, { keyword: 7, category_id: 'food' }, { keyword: 'x', category_id: '' }, null, 'bad',
  ]), [kw('grab', 'transport'), kw('Straße', 'food')]);
  const many = Array.from({ length: 600 }, (_, i) => ({ keyword: `k${i}`, category_id: 'food' }));
  assert.equal(botParseKeywords(many).length, 500);
});

test('botKeywordHits：中文包含就算；英文／数字那一端要整个词', () => {
  const cases = [
    ['买猫粮25', '猫粮', true],
    ['Grab 12.50', 'grab', true],
    ['GRAB', 'grab', true],
    ['GrabFood 18', 'grab', false],
    ['GrabFood 18', 'grabfood', true],
    ['business lunch', 'bus', false],
    ['bus 2.50', 'bus', true],
    ['午餐 12', '12', true],
    ['午餐 12.50', '12', false],
    ['午餐 1,200', '1', false],
    ['RM50', '50', false],
    ['付了 12.50', '50', false],
    ['MR.DIY Mid Valley', 'mr.diy', true],
    ['7-Eleven 4.20', '7-eleven', true],
    ['grab车 12', 'grab', true],
    ['我搭grab', 'grab', true],
    ['grabbing 5', 'grab', false],
    // 第一个出现的地方不算，后面的算
    ['grabfood 和 grab 共 30', 'grab', true],
  ];
  for (const [src, k, want] of cases) assert.equal(botKeywordHits(src, k), want, `${src} / ${k}`);
});

test('审核 M-8：多个空白／换行当一个空白；全形英数当半形（NFKC）', () => {
  assert.equal(botKeywordHits('JAYA  GROCER 45', 'jaya grocer'), true);
  assert.equal(botKeywordHits('Jaya\nGrocer SDN BHD', 'jaya grocer'), true);
  assert.equal(botKeywordHits('ＧＲＡＢ　１２.５０', 'grab'), true);
  assert.equal(botKeywordHits('Grab 12.50', 'ｇｒａｂ'), true);
  assert.equal(botKeywordHits('ＧＲＡＢＦＯＯＤ', 'grab'), false, '全形也照「整个词」');
  assert.equal(botKeywordHits('午餐 １２.５０', '12'), false);
});

test('App 存的关键词（normalizeKeyword）在 bot 一定比对得到原本的写法（两边规则一致）', () => {
  for (const s of ['GrabFood', 'MR.DIY', '猫粮', 'Straße', 'İstanbul', 'Jaya Grocer', '7-Eleven', 'ÀÉÎ']) {
    assert.equal(botKeywordHits(`${s} 12`, normalizeKeyword(s)), true, s);
    // ß 转大写是 SS（再转小写变 ss），本来就不是同一个字：这个不比大写
    if (s !== 'Straße') assert.equal(botKeywordHits(`买 ${s.toUpperCase()}`, normalizeKeyword(s)), true, `${s} 大写`);
  }
});

test('botApplyKeyword：对上就换成关键词的分类，收支不变', () => {
  const r = botApplyKeyword(draft(), { sources: ['Grab 12.50'], keywords: [kw('grab', 'transport')], cats: CATS });
  assert.deepEqual(r, { draft: draft({ categoryId: 'transport' }), keyword: 'grab' });
});

test('botApplyKeyword：最长者胜；同长按字串顺序（结果固定）', () => {
  const ks = [kw('grab', 'transport'), kw('grabfood', 'food'), kw('food', 'shopping')];
  assert.equal(botApplyKeyword(draft({ categoryId: 'shopping' }), { sources: ['GrabFood 18'], keywords: ks, cats: CATS }).keyword, 'grabfood');
  // 两个都对得上（中文包含、英文整个词都成立）→ 长的赢
  const both = [kw('咖啡', 'food'), kw('咖啡豆', 'shopping')];
  assert.equal(botApplyKeyword(draft(), { sources: ['买咖啡豆 30'], keywords: both, cats: CATS }).keyword, '咖啡豆');
  const en = [kw('jaya', 'transport'), kw('jaya grocer', 'shopping')];
  assert.equal(botApplyKeyword(draft(), { sources: ['JAYA GROCER 45'], keywords: en, cats: CATS }).draft.categoryId, 'shopping');
  const tie = [kw('bb', 'shopping'), kw('aa', 'transport')];
  const r = botApplyKeyword(draft(), { sources: ['aa bb 5'], keywords: tie, cats: CATS });
  assert.deepEqual([r.keyword, r.draft.categoryId], ['aa', 'transport']);
});

test('botApplyKeyword：收支不同不套用（「Grab 退款」被 AI 认成收入）', () => {
  const d = draft({ kind: 'income', categoryId: 'side' });
  const r = botApplyKeyword(d, { sources: ['Grab 退款 15'], keywords: [kw('grab', 'transport')], cats: CATS });
  assert.deepEqual(r, { draft: d, keyword: null });
});

test('botApplyKeyword：关键词的分类已删除或不存在 → 跳过，换下一个对得上的', () => {
  const ks = [kw('grabcar', 'gone'), kw('grab', 'transport')];
  const r = botApplyKeyword(draft(), { sources: ['GrabCar 20'], keywords: ks, cats: CATS });
  assert.deepEqual([r.keyword, r.draft.categoryId], [null, 'food'], 'grabcar 分类不在；grab 不是整个词');
  const r2 = botApplyKeyword(draft(), { sources: ['grabcar grab 20'], keywords: ks, cats: CATS });
  assert.deepEqual([r2.keyword, r2.draft.categoryId], ['grab', 'transport']);
});

test('botApplyKeyword：来源有好几个（文字、说明、店名）任一个对上就算；都没有 → 照 AI', () => {
  const ks = [kw('jaya grocer', 'shopping')];
  assert.equal(botApplyKeyword(draft(), { sources: ['', '', 'JAYA GROCER SDN BHD'], keywords: ks, cats: CATS }).keyword, 'jaya grocer');
  assert.deepEqual(botApplyKeyword(draft(), { sources: ['早餐 6.9'], keywords: ks, cats: CATS }), { draft: draft(), keyword: null });
  assert.deepEqual(botApplyKeyword(draft(), { sources: ['早餐 6.9'], keywords: [], cats: CATS }), { draft: draft(), keyword: null });
});
