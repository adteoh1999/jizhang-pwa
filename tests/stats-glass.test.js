import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

// 统计页：摘要卡（B 改版后是深绿卡，见 green-card.test.js）、分类列
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
