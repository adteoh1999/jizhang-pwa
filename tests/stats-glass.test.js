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

test('category rows JS: data-icon on the row, bar width shared with slideX, RM split + sr-only（单色化后 data-icon 留着无样式）', () => {
  assert.match(statsJs, /slideX\(r\.ratio, 6\)/);
  // B 改版：分类条单色，不再需要 --bar-w（渐层宽度）
  assert.doesNotMatch(statsJs, /--bar-w/);
  assert.match(statsJs, /class: 'stats-row', 'data-icon': iconAttr/);
  assert.match(statsJs, /class: 'stats-row-pct'/);
  assert.match(statsJs, /class: 'stats-row-amount', 'aria-hidden': 'true'[^\n]*\n\s*h\('span', \{ class: 'sr-only' \}, formatRM\(/);
});
