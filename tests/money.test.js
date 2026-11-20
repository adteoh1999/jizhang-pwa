import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatRM, minorToDecimalString, MAX_MINOR } from '../js/money.js';

test('MAX_MINOR', () => { assert.equal(MAX_MINOR, 9999999999); });
test('parseAmount 接受的写法', () => {
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('1,234.5'), 123450);
  assert.equal(parseAmount('12.'), 1200);
  assert.equal(parseAmount('.5'), 50);
  assert.equal(parseAmount(' 8 '), 800);
  assert.equal(parseAmount('0.01'), 1);
  assert.equal(parseAmount('99999999.99'), 9999999999);
  assert.equal(parseAmount('1,234,567.8'), 123456780);
});
test('parseAmount 拒绝的写法', () => {
  for (const s of ['', '0', '0.00', '-3', '1.234', 'abc', '1..2', '100000000', '1,2,3.4.5',
                   '12,50', '1,2', '1e3', ',5', '1,23', '.', ' ', '+5',
                   '0,500', '0,123', '00,500', '000,001'])
    assert.equal(parseAmount(s), null, s);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(5), null);
});
test('parseAmount 不受浮点误差影响', () => {
  assert.equal(parseAmount('0.29'), 29);
  assert.equal(parseAmount('1.15'), 115);
});
test('formatRM', () => {
  assert.equal(formatRM(123450), 'RM 1,234.50');
  assert.equal(formatRM(5), 'RM 0.05');
  assert.equal(formatRM(0), 'RM 0.00');
  assert.equal(formatRM(-2000, { sign: 'negative' }), '−RM 20.00');
  assert.equal(formatRM(-2000), '−RM 20.00');
  assert.equal(formatRM(-2000, { sign: 'none' }), 'RM 20.00');
  assert.equal(formatRM(2000, { sign: 'always' }), '+RM 20.00');
  assert.equal(formatRM(2000, { sign: 'negative' }), 'RM 20.00');
});
test('minorToDecimalString', () => {
  assert.equal(minorToDecimalString(1250), '12.50');
  assert.equal(minorToDecimalString(7), '0.07');
});
