// 通用防线（2026-11-27 改版）：CSS 里每个没有后备值的 var(--x)，都必须有人定义——
// 在 CSS 某处宣告 `--x:`，或由 js/ 用 setProperty('--x', …) 设定。
// 改名、删 token 时漏改的用处，浏览器只会静默失效，这条测试负责抓。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { css } from './helpers/css-tokens.js';

const root = new URL('../', import.meta.url);

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) out.push(...jsFiles(`${rel}/`));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/** CSS 里用到、没有后备值的变数名称。 */
export function usedWithoutFallback(src) {
  return new Set([...src.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
}

/** CSS 宣告过的变数名称。 */
export function declaredInCss(src) {
  return new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

/** js/ 里用 setProperty 设定的变数名称。 */
function setByJs() {
  const names = new Set();
  for (const f of jsFiles('js/')) {
    const src = readFileSync(new URL(f, root), 'utf8');
    for (const m of src.matchAll(/setProperty\(\s*['"`](--[\w-]+)['"`]/g)) names.add(m[1]);
  }
  return names;
}

test('helpers：抓得到没定义的变数（自我检查）', () => {
  const sample = '.a { color: var(--x); background: var(--y, red); } :root { --z: 1px; } .b { margin: var(--z); }';
  assert.deepEqual([...usedWithoutFallback(sample)].sort(), ['--x', '--z']);
  assert.deepEqual([...declaredInCss(sample)], ['--z']);
});

test('每个没有后备值的 var(--x) 都有定义（CSS 宣告或 JS setProperty）', () => {
  const declared = declaredInCss(css);
  const js = setByJs();
  const missing = [...usedWithoutFallback(css)].filter((n) => !declared.has(n) && !js.has(n));
  assert.deepEqual(missing, []);
});
