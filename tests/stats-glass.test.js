import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

// v2.4 统计页晨雾玻璃：摘要卡、走势图卡、分段控件（只在统计页）、光晕、分类列
const root = new URL('../', import.meta.url);
const statsJs = readFileSync(new URL('js/ui/stats-view.js', root), 'utf8');

// 区块里「声明符合 decl」的那几条规则的选择器（逗号拆开、去空白）
const selectorsWith = (block, decl) => {
  const out = [];
  for (const m of block.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (decl.test(m[2])) out.push(...m[1].split(',').map((x) => x.trim()));
  }
  return out;
};

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
  const hidden = selectorsWith(fb, /display:\s*none/);
  for (const sel of ['.glass-card::before', '.stats-body .segmented::after', '.stats-month::after']) {
    assert.ok(hidden.includes(sel), `${sel} must be display:none in the fallback`);
  }
  const opaque = selectorsWith(fb, /background:\s*var\(--glass\)/);
  for (const sel of ['.glass-card', '.stats-body .segmented']) {
    assert.ok(opaque.includes(sel), `${sel} must be opaque in the fallback`);
  }
});

test('stats card shadow token exists in light and both dark blocks', () => {
  for (const t of [light, mediaDark, attrDark]) assert.ok(t['--stats-card-shadow'], 'missing --stats-card-shadow');
});

test('glow hangs on the month row, which never animates or builds a stacking context', () => {
  assert.match(css, /\.screen\[data-screen="stats"\] \{ isolation: isolate; \}/);
  const month = blockAfter(css, '\n.stats-month {');
  assert.ok(!/isolation|z-index|transform|opacity|filter|contain|will-change|mask|clip-path|mix-blend-mode|perspective/.test(month));
  assert.match(month, /position:\s*relative/);
  for (const t of [light, mediaDark, attrDark]) {
    assert.ok(t['--stats-glow-1'] && t['--stats-glow-2'], 'glow tokens in every theme block');
  }
  const fb = blockAfter(css, '\n@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {', css.indexOf('\n.stats-month::after {'));
  assert.match(fb, /\.stats-month::after/);
});

test('summary: three columns; long amounts / narrow screens switch to three rows (narrow rule last)', () => {
  assert.match(blockAfter(css, '\n.stats-summary {'), /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  const longAt = css.indexOf('\n.stats-summary.is-long {');
  const narrowAt = css.indexOf('.stats-summary', css.indexOf('@media (max-width: 359px)', longAt));
  assert.ok(longAt > 0 && narrowAt > longAt, 'narrow-screen rule after .is-long');
  // 字级上限：大字级时三格不挤爆
  assert.match(blockAfter(css, '\n.stats-sum-v {'), /min\(0\.8824rem, 15px\)/);
});

test('summary JS: split RM for the eye, full amount for VoiceOver, is-long from the pure function', () => {
  assert.match(statsJs, /summaryIsLong\(/);
  assert.match(statsJs, /'sr-only'/);
  assert.match(statsJs, /rmParts\(/);
  // 三格看得到的金额都要 aria-hidden，各自配一个 sr-only
  assert.equal((statsJs.match(/class: 'stats-sum-v[^']*', 'aria-hidden': 'true'/g) || []).length, 3);
  assert.equal((statsJs.match(/class: 'stats-sum-v/g) || []).length, 3);
  assert.equal((statsJs.match(/class: 'sr-only'/g) || []).length, 4, '3 summary + 1 row sr-only');
  // sr-only 真的填了完整金额，而且真的放进每一格
  assert.match(statsJs, /sr\.textContent = formatRM\(minor, \{ sign \}\)/);
  assert.match(statsJs, /const cell = \(label, el, sr\) => h\([^;]*\bel, sr\)/);
  for (const k of ['income', 'expense', 'balance']) {
    assert.match(statsJs, new RegExp(`cell\\('[^']+', ${k}El, ${k}Sr\\)`), `${k} cell wires el + sr`);
  }
});

test('month row stays outside .stats-body (glow must not ride on the animated body)', () => {
  assert.match(statsJs, /const switcher = h\('div', \{ class: 'stats-month' \}/);
  const body = /const body = h\('div', \{ class: 'stats-body' \}, ([^)]*)\)/.exec(statsJs);
  assert.ok(body, 'stats-body construction');
  assert.ok(!/\bswitcher\b/.test(body[1]), 'switcher must not be a child of .stats-body');
  assert.match(statsJs, /root\.replaceChildren\(switcher, body\)/);
});

test('category bar: gradient lives on .stats-bar-fill (old [data-icon] override gone); ::before never inherits', () => {
  assert.ok(!css.includes('.stats-bar-fill[data-icon]'), 'old override would hide the gradient');
  const fill = blockAfter(css, '\n.stats-bar-fill {');
  assert.match(fill, /linear-gradient\(90deg, var\(--bar-fade\) calc\(100% - var\(--bar-w, 100%\)\), transparent 100%\), var\(--cat-fg, var\(--secondary-label\)\)/);
  const before = blockAfter(css, '\n.stats-bar-fill::before {');
  assert.ok(!/inherit/.test(before));
  assert.match(before, /var\(--bar-fade\)/);   // 弹过头露出的是最淡色，不是最深色
  assert.match(blockAfter(css, '\n.stats-bar {'), /height:\s*8px/);
});

test('category tokens: --bar-fade dark equals the drawer colour at .5; --stats-track in every theme block', () => {
  for (const t of [light, mediaDark, attrDark]) {
    assert.ok(t['--bar-fade'] && t['--stats-track'], 'missing tokens');
  }
  assert.equal(attrDark['--drawer'], '#171C1A');
  assert.equal(attrDark['--bar-fade'], 'rgba(23, 28, 26, 0.5)');
});

test('category rows JS: data-icon on the row, bar width shared with slideX, RM split + sr-only', () => {
  assert.match(statsJs, /slideX\(r\.ratio, 6\)/);
  assert.match(statsJs, /barWidth\(r\.ratio, 6\)/);
  assert.match(statsJs, /'--bar-w'/);
  assert.match(statsJs, /class: 'stats-row', 'data-icon': iconAttr/);
  assert.match(statsJs, /class: 'stats-row-pct'/);
  assert.match(statsJs, /class: 'stats-row-amount', 'aria-hidden': 'true'[^\n]*\n\s*h\('span', \{ class: 'sr-only' \}, formatRM\(/);
});

test('pill colours carry grey fallbacks; high contrast turns the bar solid', () => {
  const pill = blockAfter(css, '\n.stats-row-pct {');
  assert.match(pill, /background:\s*var\(--cat-bg, var\(--ink-tint\)\)/);
  assert.match(pill, /color:\s*var\(--cat-ink, var\(--ink-2\)\)/);
  const fb = blockAfter(css, '\n@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {', css.indexOf('\n.stats-bar-fill::before {'));
  const solid = selectorsWith(fb, /background:\s*var\(--cat-fg, var\(--secondary-label\)\)/);
  for (const sel of ['.stats-bar-fill', '.stats-bar-fill::before']) {
    assert.ok(solid.includes(sel), `${sel} must be solid in high contrast`);
  }
});
