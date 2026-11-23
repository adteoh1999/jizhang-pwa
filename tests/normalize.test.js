import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, normalizeInviteCode, formatInviteCode } from '../supabase/functions/_shared/normalize.ts';

test('normalizeEmail：去前后空白、转小写', () => {
  assert.equal(normalizeEmail(' Me@X.COM '), 'me@x.com');
});

test('normalizeEmail：不像邮箱回空字串', () => {
  assert.equal(normalizeEmail('abc'), '');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail('a@' + 'x'.repeat(260) + '.com'), '');
});

test('normalizeEmail：不是字串回空字串', () => {
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(123), '');
});

test('normalizeInviteCode：去空白、去连字号、转大写', () => {
  assert.equal(normalizeInviteCode(' k7mp-q4xz '), 'K7MPQ4XZ');
  assert.equal(normalizeInviteCode('k7mp q4xz'), 'K7MPQ4XZ');
});

test('normalizeInviteCode：有容易看错的字或长度不对 → 空字串', () => {
  assert.equal(normalizeInviteCode('K7MPQ4XO'), '');   // O
  assert.equal(normalizeInviteCode('K7MPQ4X1'), '');   // 1
  assert.equal(normalizeInviteCode('K7MPQ4X'), '');    // 7 个字
  assert.equal(normalizeInviteCode('K7MPQ4XZA'), '');  // 9 个字
  assert.equal(normalizeInviteCode(undefined), '');
});

test('formatInviteCode：XXXX-XXXX', () => {
  assert.equal(formatInviteCode('K7MPQ4XZ'), 'K7MP-Q4XZ');
});
