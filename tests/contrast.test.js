import { test } from 'node:test';
import assert from 'node:assert/strict';
import { light, attrDark } from './helpers/css-tokens.js';

// 不透明底：[前景 token, 背景 token, 最低值]
const PAIRS = [
  ['--ink-2', '--drawer', 4.5], ['--income', '--drawer', 4.5],
  ['--tab-off', '--drawer', 3], ['--btn-fg', '--btn-bg', 4.5]   /* 2026-11-27 用户同意：白字压 #098354＝4.79，门槛 7→4.5（WCAG AA） */, ['--red-text', '--drawer', 4.5],
  // 直接压在整页晨雾上的次要字（统计页、设置页）：渐变的四个色都要过
  ['--ink-2', '--sky-top', 4.5], ['--ink-2', '--sky-mid', 4.5],
  ['--ink-2', '--sky-low', 4.5], ['--ink-2', '--sky-bottom', 4.5],
  // 登录页（2d）错误字直接压在晨雾上
  ['--login-error', '--sky-top', 4.5], ['--login-error', '--sky-mid', 4.5],
  ['--login-error', '--sky-low', 4.5], ['--login-error', '--sky-bottom', 4.5],
  // B 改版（2026-11-27）中性元件：「储存」深绿字、单色分类图示、统计条（非文字 ≥3）
  ['--accent-text', '--drawer', 4.5], ['--icon-ink', '--drawer', 3], ['--bar', '--drawer', 3],
];

// 半透明叠层：[前景, [最底的不透明底, 往上叠的半透明层…], 最低值]
// 统计页灰色百分比胶囊：--ink-2 压在抽屉＋--ink-tint
const GREY_PILL = [['--ink-2', ['--drawer', '--ink-tint'], 4.5]];
// 登录页（2d）：输入框（--field）压在整页背景上，框内文字 ink、次要字 ink-2
// 卡后光晕（--card-glow）压在背景上：上面若有页面字（月份等）也要 ≥4.5
const STACKS = GREY_PILL
  .concat(['--sky-top', '--sky-mid', '--sky-low', '--sky-bottom'].flatMap((sky) => [
    ['--ink', [sky, '--field'], 4.5], ['--ink-2', [sky, '--field'], 4.5],
    ['--ink-2', [sky, '--card-glow'], 4.5],
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

// 结余卡、统计摘要卡（深绿卡）的字对比改由 tests/green-card.test.js 负责（2026-11-27 B 改版拿掉光球与玻璃）。
