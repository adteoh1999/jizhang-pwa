import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

// v2.4 统计页晨雾玻璃：摘要卡、走势图卡、分段控件（只在统计页）、光晕、分类列
const root = new URL('../', import.meta.url);
const statsJs = readFileSync(new URL('js/ui/stats-view.js', root), 'utf8');

test('glass card: same glass tokens as the balance card, no blur, own stacking context', () => {
  const card = blockAfter(css, '\n.glass-card {');
  assert.ok(!/backdrop-filter|filter:/.test(card));
  assert.match(card, /linear-gradient\(155deg, var\(--card-glass-1\), var\(--card-glass-2\)\)/);
  assert.match(card, /box-shadow:\s*var\(--stats-card-shadow\)/);
  assert.match(card, /isolation:\s*isolate/);
  assert.match(card, /position:\s*relative/);
});

test('glass card rim: ::before under the content (z-index -1), inside @supports mask, with a plain-border fallback', () => {
  const sup = blockAfter(css, '\n@supports (mask-composite: exclude) or (-webkit-mask-composite: xor) {', css.indexOf('\n.glass-card {'));
  const rim = blockAfter(sup, '.glass-card::before {');
  assert.match(rim, /z-index:\s*-1/);
  assert.match(rim, /pointer-events:\s*none/);
  assert.match(rim, /var\(--card-rim-1\)/);
  const no = blockAfter(css, '\n@supports not ((mask-composite: exclude) or (-webkit-mask-composite: xor)) {', css.indexOf('\n.glass-card {'));
  assert.match(no, /\.glass-card \{ border: 1px solid var\(--card-rim-2\); \}/);
});

test('stats segmented control gets the glass; the entry sheet one does not change', () => {
  assert.match(css, /\n\.stats-body \.segmented \{[^}]*var\(--card-glass-1\)/);
  assert.match(css, /\n\.modal-sheet \.segmented \{ background: var\(--ink-tint\); border-color: transparent; \}/);
  const sup = blockAfter(css, '\n@supports (mask-composite: exclude) or (-webkit-mask-composite: xor) {', css.indexOf('\n.stats-body .segmented {'));
  const rim = blockAfter(sup, '.stats-body .segmented::after {');
  assert.match(rim, /pointer-events:\s*none/);
  assert.match(rim, /z-index:\s*0/);   // 低于 .segment（z-index:1）的字，胶囊在 ::before
});

test('increase contrast / reduce transparency: rims off, stats glass opaque (rule comes after the glass rules)', () => {
  const marker = '\n@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {';
  const at = css.indexOf(marker, css.indexOf('\n.stats-body .segmented {'));
  assert.ok(at > css.indexOf('\n.glass-card {'), 'fallback must come after the glass rules');
  const fb = blockAfter(css, marker, css.indexOf('\n.stats-body .segmented {'));
  assert.match(fb, /\.glass-card::before/);
  assert.match(fb, /\.stats-body \.segmented::after/);
  assert.match(fb, /display:\s*none/);
  assert.match(fb, /background:\s*var\(--glass\)/);
});

test('stats card shadow token exists in light and both dark blocks', () => {
  for (const t of [light, mediaDark, attrDark]) assert.ok(t['--stats-card-shadow'], 'missing --stats-card-shadow');
});
