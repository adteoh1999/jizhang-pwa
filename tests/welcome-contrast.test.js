// 欢迎页（B 改版 2026-11-27）：示例深绿卡的字由 tests/green-card.test.js 负责；
// 这里测账单小卡（白面板 --drawer）上的字，以及第二张小卡整组半透明（opacity）叠在背景上的情况。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { css, light, attrDark } from './helpers/css-tokens.js';

const tokens = { light, dark: { ...light, ...attrDark } };
function resolve(theme, name, depth = 0) {
  const v = tokens[theme][name];
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
const color = (theme, name) => parse(resolve(theme, name));
const over = (bg, rgb, a) => bg.map((c, i) => rgb[i] * a + c * (1 - a));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
const layer = (theme, bg, name) => { const c = color(theme, name); return over(bg, c.rgb, c.a); };

// 第二张小卡整组半透明（.wl-layer-tx2 .wl-tx 的 opacity）
const TX2_OPACITY = Number(css.match(/\.wl-layer-tx2 \.wl-tx \{[^}]*opacity:\s*([\d.]+)/)[1]);
const SKIES = ['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'];

test('第二张小卡的透明度读得到', () => {
  assert.ok(TX2_OPACITY > 0.5 && TX2_OPACITY <= 1, String(TX2_OPACITY));
});

for (const theme of ['light', 'dark']) {
  for (const sky of SKIES) {
    for (const fg of ['--ink', '--ink-2', '--income']) {
      for (const op of [1, TX2_OPACITY]) {
        test(`${theme} 欢迎页小卡 ${fg}（不透明度 ${op}）：${sky}＋白面板 ≥ 4.5`, () => {
          const under = color(theme, sky).rgb;
          const panel = layer(theme, under, '--drawer');
          const text = layer(theme, panel, fg);
          const r = ratio(over(under, text, op), over(under, panel, op)); // 整组半透明：底色与文字都和底下混
          assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
        });
      }
    }
  }
}
