// 3c-1 审核建议 3（3c-2 补）：欢迎页的示例卡片与账单小卡压在 4 个光球上，字的对比度要够。
// 算法同 tests/contrast.test.js 的首页结余卡：光球位置、大小、淡出（70% 半径淡完）直接从 CSS 读，
// 屏幕宽 320／375／390／430 各算一次，整个光球层每 4px 取一点，取最差的一点（不管卡片实际放在哪，更保守）。
// （4 个光球全叠在同一点太悲观：它们分散在四个角，画面上不会出现，深色时会算出 2.3:1 的假警报。）
// 不含：卡片叠在小卡上、上层卡片的阴影落在下层小卡上（复审建议 2）——这两种靠无头 Chrome 截图目测。
// 假设：.login 占满屏幕宽（左右内距 24px＋safe，光球层左右伸出同样的量 → 层宽＝屏幕宽）；以后 .login 加 max-width 要跟着改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { css, blockAfter, light, attrDark } from './helpers/css-tokens.js';

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

// 光球直接从 CSS 读（.wl-hero::before）：x 是光球层宽度的百分比（层左右伸到屏幕边 → 层宽＝屏幕宽），y 是 px
const ORB_BLOCK = blockAfter(css, '\n.wl-hero::before {');
const LAYER_H = Number(ORB_BLOCK.match(/\bheight:\s*(\d+)px/)[1]);
const ORBS = [...ORB_BLOCK.matchAll(/radial-gradient\((\d+)px (\d+)px at ([\d.]+)% (\d+)px, var\((--orb-\d)\), transparent 70%\)/g)]
  .map((m) => ({ rx: +m[1], ry: +m[2], fx: +m[3] / 100, cy: +m[4], token: m[5] }));
const ORB_TOKENS = ORBS.map((o) => o.token);
const SCREEN_WIDTHS = [320, 375, 390, 430, 768]; // 768：锁住宽屏不会更差（复审建议 3）
// 第二张小卡整组半透明（.wl-layer-tx2 .wl-tx 的 opacity）
const TX2_OPACITY = Number(css.match(/\.wl-layer-tx2 \.wl-tx \{[^}]*opacity:\s*([\d.]+)/)[1]);

/** 光球层里每个取样点的底色（晨雾＋光球）；CSS 背景先写的在上面 → 由最后一个往上叠。 */
function* orbPoints(theme, sky) {
  const orbs = ORBS.map((o) => ({ ...o, c: color(theme, o.token) }));
  for (const W of SCREEN_WIDTHS) {
    for (let x = 0; x <= W; x += 4) {
      for (let y = 0; y <= LAYER_H; y += 4) {
        let bg = color(theme, sky).rgb;
        for (const o of [...orbs].reverse()) {
          const d = Math.hypot((x - o.fx * W) / o.rx, (y - o.cy) / o.ry);
          if (d < 0.7) bg = over(bg, o.c.rgb, o.c.a * (1 - d / 0.7));
        }
        yield bg;
      }
    }
  }
}
function worst(theme, sky, fn) {
  let w = Infinity;
  for (const under of orbPoints(theme, sky)) w = Math.min(w, fn(under));
  return w;
}

const SKIES = ['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'];

test('欢迎页光球：从 CSS 读到 4 个（含位置）、第二张小卡的透明度读得到', () => {
  assert.deepEqual(ORB_TOKENS, ['--orb-1', '--orb-2', '--orb-3', '--orb-4']);
  for (const o of ORBS) assert.ok(o.rx > 0 && o.ry > 0 && o.fx >= 0 && o.fx <= 1 && o.cy >= 0 && o.cy <= LAYER_H, JSON.stringify(o));
  assert.ok(TX2_OPACITY > 0.5 && TX2_OPACITY <= 1, String(TX2_OPACITY));
});

for (const theme of ['light', 'dark']) {
  for (const sky of SKIES) {
    // 示例结余卡：玻璃渐层两端都算；金额 ink、次要字 card-ink-2
    for (const glass of ['--card-glass-1', '--card-glass-2']) {
      for (const fg of ['--ink', '--card-ink-2']) {
        test(`${theme} 欢迎页卡片 ${fg}：${sky}＋光球＋${glass} ≥ 4.5`, () => {
          const r = worst(theme, sky, (under) => {
            const bg = layer(theme, under, glass);
            return ratio(layer(theme, bg, fg), bg);
          });
          assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
        });
      }
    }
    // 账单小卡：名称 ink、备注 ink-2、收入金额 income；第二张整组 opacity
    for (const fg of ['--ink', '--ink-2', '--income']) {
      for (const op of [1, TX2_OPACITY]) {
        test(`${theme} 欢迎页小卡 ${fg}（不透明度 ${op}）：${sky}＋光球＋chip ≥ 4.5`, () => {
          const r = worst(theme, sky, (under) => {
            const chip = layer(theme, under, '--chip-bg');
            const text = layer(theme, chip, fg);
            return ratio(over(under, text, op), over(under, chip, op)); // 整组半透明：底色与文字都和底下混
          });
          assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
        });
      }
    }
  }
}
