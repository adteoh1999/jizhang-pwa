// 3e 关键词资料模型：正规化、检查、建立列。
// 服务器 CHECK：keyword = lower(btrim(keyword)) and char_length(keyword) between 1 and 20（码点数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeyword, checkKeyword, buildKeyword, KEYWORD_MAX, KEYWORD_LIMIT, ValidationError } from '../js/model.js';

const active = (...ks) => ks.map((keyword) => ({ keyword, category_id: 'transport' }));

test('常数：最多 20 字、200 个', () => {
  assert.equal(KEYWORD_MAX, 20);
  assert.equal(KEYWORD_LIMIT, 200);
});

test('normalizeKeyword：去头尾空白（含全形空白、tab）、转小写、去零宽字元', () => {
  assert.equal(normalizeKeyword('  GrabFood '), 'grabfood');
  assert.equal(normalizeKeyword('　猫粮\t'), '猫粮');
  assert.equal(normalizeKeyword('gr​ab﻿'), 'grab');
  assert.equal(normalizeKeyword('⁠MR.DIY‍'), 'mr.diy');
  assert.equal(normalizeKeyword(null), '');
  assert.equal(normalizeKeyword(undefined), '');
  // 结果再正规化一次不变（服务器的 lower(btrim()) 也不会再变）
  for (const s of ['  GrabFood ', 'İstanbul', 'ÀÉÎ', 'Ⅻ']) assert.equal(normalizeKeyword(normalizeKeyword(s)), normalizeKeyword(s));
});

test('checkKeyword：空白 → empty', () => {
  assert.equal(checkKeyword('   ', { active: [], selfKeyword: null }), 'empty');
  assert.equal(checkKeyword('​', { active: [], selfKeyword: null }), 'empty');
});

test('checkKeyword：字数以码点算、在转小写之后算（20 OK、21 → long）', () => {
  assert.equal(checkKeyword('a'.repeat(20), { active: [], selfKeyword: null }), null);
  assert.equal(checkKeyword('a'.repeat(21), { active: [], selfKeyword: null }), 'long');
  assert.equal(checkKeyword('😀'.repeat(20), { active: [], selfKeyword: null }), null);
  assert.equal(checkKeyword('😀'.repeat(21), { active: [], selfKeyword: null }), 'long');
  // 'İ' 转小写变 2 个码点：20 个 İ → 40 码点 → long（先算再转会存进超长的值，服务器会拒）
  assert.equal([...'İ'.toLowerCase()].length, 2);
  assert.equal(checkKeyword('İ'.repeat(20), { active: [], selfKeyword: null }), 'long');
});

test('checkKeyword：中间有控制字元 → bad（含 U+0000，Postgres 不收）', () => {
  assert.equal(checkKeyword('gr\tab', { active: [], selfKeyword: null }), 'bad');
  assert.equal(checkKeyword('gr\u0000ab', { active: [], selfKeyword: null }), 'bad');
  assert.equal(checkKeyword('gr\nab', { active: [], selfKeyword: null }), 'bad');
});

test('checkKeyword：跟别的关键词重复 → dup；改的是自己不算', () => {
  assert.equal(checkKeyword('GRAB', { active: active('grab', 'mrt'), selfKeyword: null }), 'dup');
  assert.equal(checkKeyword('grab', { active: active('grab', 'mrt'), selfKeyword: 'grab' }), null);
  assert.equal(checkKeyword('mrt', { active: active('grab', 'mrt'), selfKeyword: 'grab' }), 'dup');
});

test('checkKeyword：新增时已有 200 个 → limit；199 个可以；改名不算新增', () => {
  const many = (n) => active(...Array.from({ length: n }, (_, i) => `k${i}`));
  assert.equal(checkKeyword('new', { active: many(199), selfKeyword: null }), null);
  assert.equal(checkKeyword('new', { active: many(200), selfKeyword: null }), 'limit');
  assert.equal(checkKeyword('new', { active: many(200), selfKeyword: 'k0' }), null);
});

test('buildKeyword：id＝关键词（正规化后）、dirty 1、deleted false、时间往前走', () => {
  const now = new Date('2026-11-27T10:00:00.000Z');
  const rec = buildKeyword({ keyword: ' Grab ', categoryId: 'transport' }, null, { now });
  assert.deepEqual(rec, { id: 'grab', keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T10:00:00.000Z', deleted: false, dirty: 1 });
  // 复活已删除的列：时间一定比旧的大（即使手机时钟比较慢）
  const old = { ...rec, deleted: true, updated_at: '2026-11-27T11:00:00.000Z' };
  const back = buildKeyword({ keyword: 'grab', categoryId: 'food' }, old, { now });
  assert.equal(back.deleted, false);
  assert.equal(back.category_id, 'food');
  assert.equal(back.updated_at, '2026-11-27T11:00:00.001Z');
});

test('buildKeyword：关键词不合格或没有分类 → ValidationError', () => {
  const now = new Date();
  assert.throws(() => buildKeyword({ keyword: '  ', categoryId: 'food' }, null, { now }), ValidationError);
  assert.throws(() => buildKeyword({ keyword: 'a'.repeat(21), categoryId: 'food' }, null, { now }), ValidationError);
  assert.throws(() => buildKeyword({ keyword: 'grab', categoryId: '' }, null, { now }), ValidationError);
  assert.throws(() => buildKeyword({ keyword: 'grab', categoryId: 'x'.repeat(65) }, null, { now }), ValidationError);
});
