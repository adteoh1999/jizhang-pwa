// v3.4.1（用户 2026-11-27 真机看过后选定）：深绿卡上收入改白、比例线／分类条渐变。
// v3.7（2026-11-28）：比例线 薄荷 → 经典金、超支改玫瑰红、分类条每条金头绿尾（规格 docs/superpowers/specs/2026-11-28-gold-accent-design.md）。
// 填充条固定 100% 宽、用 translateX 往左藏 → 渐变跟着元素走，露出的是「尾端」；尾端一律是对比最高的颜色。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';
import { cardView } from '../js/ui/home.js';

const homeJs = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');

// ---------- 颜色小工具 ----------
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
/** 前景色（条本身）：必须不透明，否则下面只取 rgb 的对比算法会算错（审核 M-2）。 */
const solid = (theme, name) => { const c = color(theme, name); assert.equal(c.a, 1, `${name} 要不透明`); return c.rgb; };
const over = (bg, c) => bg.map((x, i) => c.rgb[i] * c.a + x * (1 - c.a));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
/** 深绿卡某色站＋两层光泽（最亮处＝浅色前景最差的情况）。 */
const cardAt = (theme, stop) => over(over(color(theme, stop).rgb, color(theme, '--card-sheen-white')), color(theme, '--card-sheen-mint'));

// v3.7 金色强调色（用户 2026-11-28 选 B 经典金）：比例线 薄荷 → 金；超支玫瑰红；分类条 金 → 绿
const METER = { '--meter-from': '#86D2AB', '--meter-to': 'var(--gold)', '--meter-over-from': '#FFC2CF', '--meter-over-to': '#FF8AA5' };
const BAR = { light: { '--bar-from': '#D7B157', '--bar-to': '#076B44' }, dark: { '--bar-from': 'var(--gold)', '--bar-to': '#8FD8B4' } };

// ---------- token ----------
test('token：比例线／超支渐变三块都有且相同；分类条渐变浅深各一组；旧的 --card-income、--card-fill、--bar 拿掉', () => {
  for (const t of [light, mediaDark, attrDark]) {
    for (const [n, v] of Object.entries(METER)) assert.equal(t[n], v, n);
    for (const n of ['--card-income', '--card-fill', '--bar']) assert.ok(!(n in t), `still has ${n}`);
  }
  for (const [n, v] of Object.entries(BAR.light)) assert.equal(light[n], v, n);
  for (const t of [mediaDark, attrDark]) for (const [n, v] of Object.entries(BAR.dark)) assert.equal(t[n], v, n);
  for (const n of ['--card-income', '--card-fill', '--bar']) assert.ok(!css.includes(`var(${n})`), `still used: ${n}`);
});

// ---------- 对比度 ----------
for (const theme of ['light', 'dark']) {
  for (const stop of ['--card-1', '--card-2', '--card-3']) {
    // v3.7：比例线是卡内最后一个元素、在卡片最下方；右上薄荷光泽纵向只到卡高 0.9×0.55＝49.5%，照不到那一排
    // （前提由 tests/gold-accent.test.js 锁住）→ 只叠斜向白光泽。卡上「字」的测试仍用含两层光泽的最严模型。
    test(`${theme} 比例线尾端 --meter-to 对「${stop}＋白光泽＋轨道」≥ 3（比例线那一排薄荷光照不到）`, () => {
      const bg = over(color(theme, stop).rgb, color(theme, '--card-sheen-white'));
      const r = ratio(solid(theme, '--meter-to'), over(bg, color(theme, '--card-track')));
      assert.ok(r >= 3, `${r.toFixed(2)} < 3`);
    });
    // 支出刚好等于收入（100%、不算超支）时整条露出，开头旁边是卡；超支时满格，两端旁边都是卡
    for (const n of ['--meter-from', '--meter-over-from', '--meter-over-to']) {
      test(`${theme} ${n} 对「${stop}＋光泽」≥ 3`, () => {
        const r = ratio(solid(theme, n), cardAt(theme, stop));
        assert.ok(r >= 3, `${r.toFixed(2)} < 3`);
      });
    }
  }
  // 统计分类条（v3.7 每条「金头 → 绿尾」）：长度由尾端决定，尾端对抽屉与轨道 ≥3（WCAG 非文字）；
  // 开头（金）对抽屉 ≥2 是自订下限，不是 WCAG：每条开头不能淡到看不见（看起来比实际短）。
  // 旧的「中点 ≥3／三通道同方向」拿掉：每条都有金头，不再成立（尾端纯色段由 gold-accent 测试锁停靠点）
  test(`${theme} 分类条：尾端对抽屉与轨道 ≥3、开头（金）对抽屉 ≥2`, () => {
    const drawer = color(theme, '--drawer').rgb;
    const track = over(drawer, color(theme, '--stats-track'));
    const to = solid(theme, '--bar-to'), from = solid(theme, '--bar-from');
    for (const [label, fg, bg, min] of [['尾端/抽屉', to, drawer, 3], ['尾端/轨道', to, track, 3], ['开头/抽屉', from, drawer, 2]]) {
      const r = ratio(fg, bg);
      assert.ok(r >= min, `${label} ${r.toFixed(2)} < ${min}`);
    }
  });
}

// ---------- 规则形状 ----------
test('首页比例线：from→to 渐变；往左补缝的 ::before 用纯起点色（不能 inherit 出第二段渐变）', () => {
  assert.match(blockAfter(css, '\n.home-meter-fill {'), /background:\s*linear-gradient\(90deg, var\(--meter-from\), var\(--meter-to\)\)/);
  const before = blockAfter(css, '\n.home-meter-fill::before {');
  assert.match(before, /background:\s*var\(--meter-from\)/);
  assert.ok(!/inherit/.test(before), '::before 不能 inherit');
});

test('超支：.home-meter-bar.is-over 换琥珀渐变，::before 也换成琥珀起点色（回弹时左端不闪绿）', () => {
  assert.match(blockAfter(css, '\n.home-meter-bar.is-over .home-meter-fill {'), /background:\s*linear-gradient\(90deg, var\(--meter-over-from\), var\(--meter-over-to\)\)/);
  assert.match(blockAfter(css, '\n.home-meter-bar.is-over .home-meter-fill::before {'), /background:\s*var\(--meter-over-from\)/);
});

// v3.7（用户 2026-11-28 选 B）：渐变贴着填充条右缘、宽度＝看得到的长度（--bar-w，stats-view.js 设）→ 每条都是金头绿尾。
// 填充条左边藏起来的部分（底色层）与 ::before 都是纯 --bar-from：回弹时不露缝、不闪色。没有 --bar-w 时退回整条渐变。
test('统计分类条：渐变铺在看得到的长度上（金头 → 绿尾），底色层与 ::before 都是纯起点色', () => {
  const fill = blockAfter(css, '\n.stats-bar-fill {');
  assert.match(fill, /background:\s*linear-gradient\(90deg, var\(--bar-from\), var\(--bar-to\) \d+%\) right \/ var\(--bar-w, 100%\) 100% no-repeat, var\(--bar-from\);/);
  assert.match(blockAfter(css, '\n.stats-bar-fill::before {'), /background:\s*var\(--bar-from\)/);
});

test('统计分类条：每条尾端至少 20% 是纯 --bar-to（长度由对比够的尾端决定；停靠点从 CSS 读）', () => {
  const m = blockAfter(css, '\n.stats-bar-fill {').match(/var\(--bar-to\) (\d+)%\)/);
  assert.ok(m, '找不到 --bar-to 停靠点');
  assert.ok(Number(m[1]) <= 80, `停靠点 ${m[1]}% > 80%`);
});

test('欢迎页示意卡的假比例线（17%、没有 translate）用纯尾端色，跟真卡短条一样', () => {
  assert.match(blockAfter(css, '\n.wl-bar i {'), /background:\s*var\(--meter-to\)/);
});

const contrastBlocks = () => {
  const marker = '@media (prefers-contrast: more) {';
  const blocks = [];
  for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) blocks.push({ at: i, body: blockAfter(css, marker, i) });
  return blocks;
};
const contrastRule = (blocks, sel, re) => blocks.find((b) => [...b.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .some((m) => m[1].split(',').map((s) => s.trim()).includes(sel) && re.test(m[2])));

// v3.7：首页比例线（与欢迎页假比例线）在增加对比度时用较亮的金 --card-gold（对比比 --gold 高）
test('增加对比度：三种填充条（含 ::before、含超支）都改纯色，规则排在基础规则之后', () => {
  const blocks = contrastBlocks();
  const want = [
    ['.home-meter-fill', '--card-gold', '\n.home-meter-fill {'],
    ['.home-meter-fill::before', '--card-gold', '\n.home-meter-fill::before {'],
    ['.wl-bar i', '--card-gold', '\n.wl-bar i {'],
    ['.home-meter-bar.is-over .home-meter-fill', '--meter-over-to', '\n.home-meter-bar.is-over .home-meter-fill {'],
    ['.home-meter-bar.is-over .home-meter-fill::before', '--meter-over-to', '\n.home-meter-bar.is-over .home-meter-fill::before {'],
    ['.stats-bar-fill', '--bar-to', '\n.stats-bar-fill {'],
    ['.stats-bar-fill::before', '--bar-to', '\n.stats-bar-fill::before {'],
  ];
  for (const [sel, tok, base] of want) {
    const hit = contrastRule(blocks, sel, new RegExp(`background:\\s*var\\(${tok}\\)`));
    assert.ok(hit, `${sel} 高对比纯 ${tok}`);
    assert.ok(css.indexOf(base) >= 0 && hit.at > css.indexOf(base), `${sel} 的高对比规则要在基础规则之后`);
  }
});

test('增加对比度：比例线、补缝段、欢迎页假比例线、分类条的上缘亮光关掉（box-shadow: none）', () => {
  const blocks = contrastBlocks();
  for (const sel of ['.home-meter-fill', '.home-meter-fill::before', '.wl-bar i', '.stats-bar-fill', '.stats-bar-fill::before']) {
    assert.ok(contrastRule(blocks, sel, /box-shadow:\s*none/), `${sel} 高对比没有亮光`);
  }
});

// ---------- 收入改白 ----------
test('深绿卡上收入跟其他字一样白：统计摘要卡与飘字都没有收入专用颜色规则', () => {
  assert.ok(!/\.stats-sum-v\.is-income\b/.test(css), '.stats-sum-v.is-income 规则应已拿掉');
  assert.ok(!/\.home-float\.is-income\b/.test(css), '.home-float.is-income 规则应已拿掉');
  // 账单列表维持蓝色
  assert.match(css, /\.home-row-amount\.is-income \{[^}]*color:\s*var\(--income\)/);
});

// ---------- 超支标记（JS） ----------
test('cardView：over 只在显示金额且超支时为 true，而且永远等于 noteShown（琥珀色出现时一定有文字）', () => {
  const cases = [
    [{ balance: -500, income: 100, expense: 600 }, false, true],
    [{ balance: 3200, income: 10000, expense: 6800 }, false, false],
    [{ balance: 0, income: 10000, expense: 10000 }, false, false],
    [{ balance: 0, income: 0, expense: 0 }, false, false],
    [{ balance: -500, income: 100, expense: 600 }, true, false],
    [{ balance: 3200, income: 10000, expense: 6800 }, true, false],
  ];
  for (const [s, hidden, want] of cases) {
    const m = cardView(s, hidden).meter;
    assert.equal(m.over, want, JSON.stringify([s, hidden]));
    assert.equal(m.over, m.noteShown);
  }
});

test('home.js：比例线依 m.over 加减 is-over（强制布尔，免得 undefined 变成每次翻转）', () => {
  // 先去掉 // 注释，免得只剩注释提到这串字也会过（审核 M-5）
  const code = homeJs.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(code, /meterBar\.classList\.toggle\('is-over', m\.over === true\)/);
});
