// 检查 sw.js 的 ASSETS 清单：路径都存在、壳档案都在清单里、VERSION 与 APP_VERSION 相同
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../js/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const swText = readFileSync(join(root, 'sw.js'), 'utf8');

function parseAssets() {
  const m = swText.match(/const ASSETS = \[([\s\S]*?)\];/);
  assert.ok(m, 'sw.js 里找不到 ASSETS 数组');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const toRel = (u) => (u === './' ? 'index.html' : u.replace(/^\.\//, ''));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (name.startsWith('.')) continue; // .DS_Store 等
    const p = `${dir}/${name}`;
    if (statSync(join(root, p)).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test('ASSETS 里每个路径都存在于磁盘', () => {
  for (const u of parseAssets()) assert.ok(existsSync(join(root, toRel(u))), `不存在：${u}`);
});

test('ASSETS 没有重复项', () => {
  const a = parseAssets();
  assert.equal(new Set(a).size, a.length);
});

test('壳档案都列在 ASSETS 里', () => {
  const listed = new Set(parseAssets().map(toRel));
  const shell = ['index.html', 'manifest.webmanifest',
    ...walk('css'), ...walk('js'), ...walk('icons').filter((f) => f.endsWith('.png'))];
  for (const f of shell) assert.ok(listed.has(relative('.', f)), `未列入 ASSETS：${f}`);
  assert.ok(parseAssets().includes('./') && parseAssets().includes('./index.html'));
});

test('sw.js 的 VERSION 等于 APP_VERSION', () => {
  const m = swText.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'sw.js 里找不到 VERSION');
  assert.equal(m[1], APP_VERSION);
});
