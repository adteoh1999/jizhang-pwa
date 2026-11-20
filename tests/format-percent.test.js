import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPercent } from '../js/stats.js';

test('formatPercent', () => {
  assert.equal(formatPercent(0.004), '<1%');
  assert.equal(formatPercent(0.005), '1%');
  assert.equal(formatPercent(0.996), '99%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(0.214), '21%');
  assert.equal(formatPercent(0), '0%');
});
