import { test } from 'node:test';
import assert from 'node:assert/strict';
import { light, attrDark } from './helpers/css-tokens.js';

// [前景 token, 背景 token, 最低值]
const PAIRS = [
  ['--ink-2', '--drawer', 4.5], ['--ink-2', '--sky-top', 4.5], ['--income', '--drawer', 4.5],
  ['--income', '--sky-mid', 4.5], ['--tab-off', '--drawer', 3], ['--btn-fg', '--btn-bg', 7],
  ['--red-text', '--drawer', 4.5],
];

const tokens = { light, dark: { ...light, ...attrDark } };

function resolve(theme, name, depth = 0) {
  let v = tokens[theme][name];
  assert.ok(v !== undefined && depth < 10, `token ${name} (${theme})`);
  const m = v.match(/^var\((--[\w-]+)\)$/);
  return m ? resolve(theme, m[1], depth + 1) : v;
}
function parse(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, `unparseable colour ${v}`);
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function ratio(theme, fgName, bgName) {
  const bg = parse(resolve(theme, bgName));
  assert.equal(bg.a, 1, `${bgName} must be opaque`);
  const fg = parse(resolve(theme, fgName));
  const rgb = fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a)); // 合成到背景上
  const [a, b] = [lum(rgb), lum(bg.rgb)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const theme of ['light', 'dark']) {
  for (const [fg, bg, min] of PAIRS) {
    test(`${theme} ${fg} on ${bg} >= ${min}`, () => {
      const r = ratio(theme, fg, bg);
      assert.ok(r >= min, `${r.toFixed(2)} < ${min}`);
    });
  }
}
