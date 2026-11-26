import { test } from 'node:test';
import assert from 'node:assert/strict';
import { css, blockAfter, light, attrDark } from './helpers/css-tokens.js';

// 不透明底：[前景 token, 背景 token, 最低值]
const PAIRS = [
  ['--ink-2', '--drawer', 4.5], ['--income', '--drawer', 4.5],
  ['--tab-off', '--drawer', 3], ['--btn-fg', '--btn-bg', 7], ['--red-text', '--drawer', 4.5],
  // 直接压在整页晨雾上的次要字（统计页、设置页）：渐变的四个色都要过
  ['--ink-2', '--sky-top', 4.5], ['--ink-2', '--sky-mid', 4.5],
  ['--ink-2', '--sky-low', 4.5], ['--ink-2', '--sky-bottom', 4.5],
  // 登录页（2d）错误字直接压在晨雾上
  ['--login-error', '--sky-top', 4.5], ['--login-error', '--sky-mid', 4.5],
  ['--login-error', '--sky-low', 4.5], ['--login-error', '--sky-bottom', 4.5],
];

// 半透明叠层：[前景, [最底的不透明底, 往上叠的半透明层…], 最低值]
// 统计页玻璃卡（.glass-card，v2.4 晨雾玻璃）压在晨雾上：晨雾每一段 × 玻璃渐层两端（左上 / 右下）都测
// 统计页灰色（已删除 / 未分类）百分比胶囊：--ink-2 压在抽屉＋--ink-tint
const GREY_PILL = [['--ink-2', ['--drawer', '--ink-tint'], 4.5]];
const STACKS = ['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'].flatMap((sky) =>
  ['--card-glass-1', '--card-glass-2'].flatMap((glass) => [
    ['--income', [sky, glass], 4.5],
    ['--ink-2', [sky, glass], 4.5],
    ['--ink', [sky, glass], 4.5],
  ])).concat(GREY_PILL)
  // 登录页（2d）：输入框（--field）压在晨雾上，框内文字 ink、次要字 ink-2
  .concat(['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'].flatMap((sky) => [
    ['--ink', [sky, '--field'], 4.5], ['--ink-2', [sky, '--field'], 4.5],
  ]))
  // 3c-1 欢迎页：示例账单小卡（--chip-bg）压在晨雾上，名称 ink、备注 ink-2、收入金额 income
  .concat(['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'].flatMap((sky) => [
    ['--ink', [sky, '--chip-bg'], 4.5], ['--ink-2', [sky, '--chip-bg'], 4.5], ['--income', [sky, '--chip-bg'], 4.5],
  ]));

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
  const a = p.length > 3 ? p[3] : 1;
  assert.ok(a >= 0 && a <= 1 && !/%/.test(m[1]), `alpha out of range in ${v}`);
  return { rgb: p.slice(0, 3), a };
}
const color = (theme, name) => parse(resolve(theme, name));
const over = (bg, rgb, a) => bg.map((c, i) => rgb[i] * a + c * (1 - a)); // 半透明叠到底上
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(fg, bg) {
  const rgb = over(bg, fg.rgb, fg.a);
  const [a, b] = [lum(rgb), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function stackBg(theme, [base, ...layers]) {
  const b = color(theme, base);
  assert.equal(b.a, 1, `${base} must be opaque`);
  return layers.reduce((bg, n) => { const c = color(theme, n); return over(bg, c.rgb, c.a); }, b.rgb);
}

for (const theme of ['light', 'dark']) {
  for (const [fg, bg, min] of PAIRS) {
    test(`${theme} ${fg} on ${bg} >= ${min}`, () => {
      const r = contrast(color(theme, fg), stackBg(theme, [bg]));
      assert.ok(r >= min, `${r.toFixed(2)} < ${min}`);
    });
  }
  for (const [fg, layers, min] of STACKS) {
    test(`${theme} ${fg} on ${layers.join(' + ')} >= ${min}`, () => {
      const r = contrast(color(theme, fg), stackBg(theme, layers));
      assert.ok(r >= min, `${r.toFixed(2)} < ${min}`);
    });
  }
}

// ---------- 结余卡：晨雾 → 光球 → 玻璃 → 文字 ----------
// 光球直接从 CSS 读（.home-card-wrap::before），在卡片上每 4px 取一点，算最差的对比度。
const ORB_BLOCK = blockAfter(css, '\n.home-card-wrap::before {');
const LAYER_TOP = Number(ORB_BLOCK.match(/\btop:\s*(-?\d+)px/)[1]);       // 光球层在卡片上方伸出多少（负值）
const LAYER_H = Number(ORB_BLOCK.match(/\bheight:\s*(\d+)px/)[1]);
const ORBS = [...ORB_BLOCK.matchAll(
  /radial-gradient\((\d+)px (\d+)px at calc\(var\(--mx\) \+ \(100% - 2 \* var\(--mx\)\) \* ([\d.]+)\) (\d+)px, var\((--orb-\d)\), transparent 70%\)/g,
)].map((m) => ({ rx: +m[1], ry: +m[2], fx: +m[3], cy: +m[4], token: m[5] }));

test('orb layer: 4 orbs parsed from CSS', () => {
  assert.equal(ORBS.length, 4);
  assert.match(ORB_BLOCK, /z-index:\s*-1/);
  assert.match(ORB_BLOCK, /pointer-events:\s*none/);
});

test('orbs fade out inside the layer (no hard edges) and never rise above the card by more than the layer top', () => {
  assert.ok(LAYER_TOP >= -56, `layer reaches ${-LAYER_TOP}px above the card (status bar risk)`);
  for (const o of ORBS) {
    assert.ok(o.cy - 0.7 * o.ry >= 0, `${o.token} clipped at the top`);
    assert.ok(o.cy + 0.7 * o.ry <= LAYER_H, `${o.token} clipped at the bottom`);
  }
});

// 卡片宽：iPhone SE（320）、一般（375）扣掉左右 16px 边距；Pro Max（430）扣掉左右 20px
const CARD_WIDTHS = [288, 343, 390];
// 卡片高度会随字级、换行变大：纵向取样到光球层底，宁可多算

/** 光球层里的最差对比度。yFrom..yTo 以卡片顶端为 0；glassLayers 为 [null]＝没有玻璃垫底（卡片上方的月份字）。 */
function worstOnOrbs(theme, fgName, { yFrom, yTo, glassLayers, orbList = ORBS, layerTop = LAYER_TOP }) {
  const fg = color(theme, fgName);
  const orbs = orbList.map((o) => ({ ...o, c: color(theme, o.token) }));
  let worst = Infinity;
  for (const sky of ['--sky-top', '--sky-mid', '--sky-low']) {   // 小屏幕时卡片下缘接近渐变 58%
    for (const glass of glassLayers) {
      const g = glass && color(theme, glass);
      for (const W of CARD_WIDTHS) {
        for (let x = 0; x <= W; x += 4) {
          for (let y = yFrom; y <= yTo; y += 4) {
            let bg = color(theme, sky).rgb;
            // CSS 背景：先写的在上面 → 由最后一个往上叠
            for (const o of [...orbs].reverse()) {
              const d = Math.hypot((x - o.fx * W) / o.rx, (y + -layerTop - o.cy) / o.ry);
              if (d < 0.7) bg = over(bg, o.c.rgb, o.c.a * (1 - d / 0.7));
            }
            if (g) bg = over(bg, g.rgb, g.a);
            worst = Math.min(worst, contrast(fg, bg));
          }
        }
      }
    }
  }
  return worst;
}

for (const theme of ['light', 'dark']) {
  for (const fg of ['--ink', '--card-ink-2']) {
    test(`${theme} ${fg} on the balance card (mist + orbs + glass) >= 4.5`, () => {
      const r = worstOnOrbs(theme, fg, {
        yFrom: 0, yTo: LAYER_H + LAYER_TOP, glassLayers: ['--card-glass-1', '--card-glass-2'], // 玻璃是渐层，两端都测
      });
      assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
    });
  }
  // 光球层往上伸到大标题列：右边的月份字（--ink-2）直接压在光球上，没有玻璃
  test(`${theme} --ink-2 above the card (mist + orbs, no glass) >= 4.5`, () => {
    const r = worstOnOrbs(theme, '--ink-2', { yFrom: LAYER_TOP, yTo: 0, glassLayers: [null] });
    assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
  });
}

// 只看基础 .screen 规则：以后若在媒体查询或 .screen[data-screen="home"] 改 padding，要一起改光球层与这个测试
const grab = (src, re, what) => { const m = src.match(re); assert.ok(m, `missing ${what}`); return m[1].trim(); };
test('orb layer reaches exactly the screen edges (no horizontal scroll)', () => {
  const pad = blockAfter(css, '\n.screen {');
  const padL = grab(pad, /padding-left:\s*([^;]+);/, '.screen padding-left');
  const padR = grab(pad, /padding-right:\s*([^;]+);/, '.screen padding-right');
  assert.match(ORB_BLOCK, /--mx:\s*calc\(var\(--margin\) \+ var\(--safe-left\)\);/);
  assert.equal(padL, 'calc(var(--margin) + var(--safe-left))');
  assert.equal(grab(ORB_BLOCK, /\bleft:\s*([^;]+);/, 'orb left'), 'calc(-1 * var(--mx))');
  assert.equal(grab(ORB_BLOCK, /\bright:\s*([^;]+);/, 'orb right'), `calc(-1 * (${padR.replace(/^calc\((.*)\)$/, '$1')}))`);
});

// ---------- 统计页（v2.4）：晨雾 → 淡蓝光晕（.stats-month::after）→ 玻璃 → 文字 ----------
// 光晕层以月份列顶端为 0；摘要卡顶端在 56px（月份列 44 + 下边距 4 + 卡片上边距 8）。
const GLOW_BLOCK = blockAfter(css, '\n.stats-month::after {');
const GLOW_TOP = Number(GLOW_BLOCK.match(/\btop:\s*(-?\d+)px/)[1]);
const GLOW_H = Number(GLOW_BLOCK.match(/\bheight:\s*(\d+)px/)[1]);
const GLOWS = [...GLOW_BLOCK.matchAll(
  /radial-gradient\((\d+)px (\d+)px at calc\(var\(--mx\) \+ \(100% - 2 \* var\(--mx\)\) \* ([\d.]+)\) (\d+)px, var\((--stats-glow-\d)\), transparent 70%\)/g,
)].map((m) => ({ rx: +m[1], ry: +m[2], fx: +m[3], cy: +m[4], token: m[5] }));
const SUMMARY_TOP = 56;

test('stats glow: 2 glows parsed, behind content, fade out inside the layer', () => {
  assert.equal(GLOWS.length, 2);
  assert.match(GLOW_BLOCK, /z-index:\s*-1/);
  assert.match(GLOW_BLOCK, /pointer-events:\s*none/);
  assert.ok(!/animation|transition|filter/.test(GLOW_BLOCK));
  assert.ok(GLOW_TOP >= -44, `glow reaches ${-GLOW_TOP}px above the month row (status bar risk)`);
  for (const o of GLOWS) {
    assert.ok(o.cy - 0.7 * o.ry >= 0, `${o.token} clipped at the top`);
    assert.ok(o.cy + 0.7 * o.ry <= GLOW_H, `${o.token} clipped at the bottom`);
  }
});

test('stats glow reaches exactly the screen edges (no horizontal scroll)', () => {
  const pad = blockAfter(css, '\n.screen {');
  const padR = grab(pad, /padding-right:\s*([^;]+);/, '.screen padding-right');
  assert.match(GLOW_BLOCK, /--mx:\s*calc\(var\(--margin\) \+ var\(--safe-left\)\);/);
  assert.equal(grab(GLOW_BLOCK, /\bleft:\s*([^;]+);/, 'glow left'), 'calc(-1 * var(--mx))');
  assert.equal(grab(GLOW_BLOCK, /\bright:\s*([^;]+);/, 'glow right'), `calc(-1 * (${padR.replace(/^calc\((.*)\)$/, '$1')}))`);
});

for (const theme of ['light', 'dark']) {
  const glow = { orbList: GLOWS, layerTop: GLOW_TOP };
  for (const fg of ['--ink', '--card-ink-2', '--income']) {
    test(`${theme} ${fg} on the stats summary (mist + glow + glass) >= 4.5`, () => {
      const r = worstOnOrbs(theme, fg, { ...glow, yFrom: SUMMARY_TOP, yTo: GLOW_H + GLOW_TOP, glassLayers: ['--card-glass-1', '--card-glass-2'] });
      assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
    });
  }
  // 大标题、月份列直接压在光晕上，没有玻璃
  test(`${theme} --ink above the stats summary (mist + glow, no glass) >= 4.5`, () => {
    const r = worstOnOrbs(theme, '--ink', { ...glow, yFrom: GLOW_TOP, yTo: SUMMARY_TOP, glassLayers: [null] });
    assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
  });
}
