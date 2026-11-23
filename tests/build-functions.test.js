import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { bundle } from '../scripts/build-functions.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

test('打包：_shared 的 import 换成文件内容', () => {
  const out = bundle(join(fixtures, 'fn-demo/functions'), 'demo');
  assert.doesNotMatch(out, /from\s+['"]\.\.\/_shared/);
  assert.match(out, /function double/);
  assert.match(out, /PREFIX/);
});

test('打包：输出可以直接载入执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fn-build-'));
  try {
    const file = join(dir, 'demo.ts');
    writeFileSync(file, bundle(join(fixtures, 'fn-demo/functions'), 'demo'));
    const mod = await import(pathToFileURL(file).href);
    assert.equal(mod.handleDemo(3), 'v=6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('打包：import 用了「as 改名」→ 直接报错（规则不允许）', () => {
  assert.throws(() => bundle(join(fixtures, 'fn-alias/functions'), 'demo'), /as/);
});
