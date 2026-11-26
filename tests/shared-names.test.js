// 3d 审核：_shared 档打包后会并成一个档，所有档的顶层名字（含没 export 的、型别）不能撞名
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../supabase/functions/_shared/', import.meta.url);

test('_shared 全部档的顶层名字没有重复', () => {
  const seen = new Map();
  const dup = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) dup.push(`${m[1]}（${seen.get(m[1])}、${f}）`);
      else seen.set(m[1], f);
    }
  }
  assert.ok(seen.size > 50, '应该抓到很多名字：' + seen.size);
  assert.deepEqual(dup, []);
});

test('每个函数的 index.ts 顶层名字不和 _shared 撞名（打包后同一个档）', () => {
  const re = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const shared = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(re)) shared.add(m[1]);
  }
  const fnDir = new URL('../supabase/functions/', import.meta.url);
  const dup = [];
  for (const d of readdirSync(fnDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '_shared')) {
    let src;
    try { src = readFileSync(new URL(`${d.name}/index.ts`, fnDir), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(re)) if (shared.has(m[1])) dup.push(`${d.name}: ${m[1]}`);
  }
  assert.deepEqual(dup, []);
});
