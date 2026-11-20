import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url);
export const css = readFileSync(new URL('css/app.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 取 `selector {` 之后配对的大括号内容
export function blockAfter(src, marker, from = 0) {
  const i = src.indexOf(marker, from);
  assert.ok(i >= 0, `missing ${marker}`);
  let depth = 0;
  const start = src.indexOf('{', i);
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(start + 1, k);
  }
  throw new Error('unbalanced');
}
export function namesAndValues(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

export const light = namesAndValues(blockAfter(css, ':root {'));
const mediaBlock = blockAfter(css, '@media (prefers-color-scheme: dark)');
export const mediaDark = namesAndValues(blockAfter(mediaBlock, ':root:not([data-theme="light"])'));
export const attrDark = namesAndValues(blockAfter(css, ':root[data-theme="dark"]'));
