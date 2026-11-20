import test from 'node:test';
import assert from 'node:assert/strict';
import { pillIndex } from '../js/ui/tabbar.js';

test('pillIndex returns tab position', () => {
  const tabs = [{ id: 'home' }, { id: 'stats' }, { id: 'settings' }];
  assert.equal(pillIndex(tabs, 'home'), 0);
  assert.equal(pillIndex(tabs, 'stats'), 1);
  assert.equal(pillIndex(tabs, 'settings'), 2);
  assert.equal(pillIndex(tabs, 'nope'), 0);
});
