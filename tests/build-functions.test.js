import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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

function tmpFunctions(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fn-src-'));
  for (const [p, s] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), s);
  }
  return dir;
}

test('打包：同一个 _shared 档 import 两行，只插入一次', () => {
  const dir = tmpFunctions({
    '_shared/a.ts': 'export const A = 1;\nexport const B = 2;\n',
    'demo/index.ts': "import { A } from '../_shared/a.ts';\nimport { B } from '../_shared/a.ts';\nexport const x = A + B;\n",
  });
  try {
    const out = bundle(dir, 'demo');
    assert.equal(out.match(/export const A = 1/g).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('打包：看不懂的 _shared import（多行、* as）→ 报错', () => {
  const dir = tmpFunctions({
    '_shared/a.ts': 'export const A = 1;\n',
    'demo/index.ts': "import * as S from '../_shared/a.ts';\nexport const x = S.A;\n",
  });
  try { assert.throws(() => bundle(dir, 'demo'), /看不懂/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('打包：_shared 档自己再 import 或 export from → 报错', () => {
  for (const shared of ["import { y } from './b.ts';\nexport const A = y;\n", "export { y } from './b.ts';\n"]) {
    const dir = tmpFunctions({
      '_shared/a.ts': shared,
      'demo/index.ts': "import { A } from '../_shared/a.ts';\nexport const x = A;\n",
    });
    try { assert.throws(() => bundle(dir, 'demo'), /不能再/); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('打包：_shared 里不带空格或跨多行的 import / export from 也挡得住', () => {
  for (const shared of ["import'./b.ts';\nexport const A = 1;\n", "export * from'./b.ts';\nexport const A = 1;\n", "export {\n  y,\n} from './b.ts';\nexport const A = 1;\n"]) {
    const dir = tmpFunctions({
      '_shared/a.ts': shared,
      'demo/index.ts': "import { A } from '../_shared/a.ts';\nexport const x = A;\n",
    });
    try { assert.throws(() => bundle(dir, 'demo'), /不能再/, shared); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
