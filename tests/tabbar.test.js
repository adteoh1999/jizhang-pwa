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

test('tabbar.js 用 tabIcon（线条／实心双版本），不再用单版 icon()', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/ui/tabbar.js', import.meta.url), 'utf8');
  const imp = src.indexOf("import { tabIcon } from './icons.js';");
  assert.ok(imp >= 0, 'import tabIcon');
  const call = src.indexOf('tabIcon(t.icon)');
  assert.ok(call >= 0, 'tabIcon(t.icon) 呼叫');
  assert.ok(!/\bicon\(t\.icon/.test(src), '不再呼叫 icon(t.icon, …)');
});
