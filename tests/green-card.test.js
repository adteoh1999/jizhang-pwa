// B 深绿卡（2026-11-27 改版）：首页结余卡、统计摘要卡、欢迎页示意卡共用一套深绿卡。
// 重点：卡上字一律用 --card-* token（反向扫描）、字对「深绿＋光泽最亮处」≥4.5、长金额不会被裁、没有细纹。
import test from 'node:test';
import assert from 'node:assert/strict';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

// ---------- 小工具 ----------
/** 所有「最内层」规则：{ sel, body }（@media 里的规则也抓得到；选择器只含该规则自己）。 */
function rules(src = css) {
  return [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
}
const selList = (sel) => sel.split(',').map((s) => s.trim());

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

const CARD_SEL = ['.home-card', '.stats-summary', '.wl-card'];
const NEW_TOKENS = ['--card-1', '--card-2', '--card-3', '--card-ink', '--card-ink-2', '--card-ink-dec', '--card-income',
  '--card-track', '--card-fill', '--card-line', '--card-sheen-mint', '--card-sheen-white', '--card-glow', '--card-shadow', '--panel-shadow'];
const GONE_TOKENS = ['--orb-1', '--orb-2', '--orb-3', '--orb-4', '--card-glass-1', '--card-glass-2',
  '--card-rim-1', '--card-rim-2', '--card-rim-3', '--card-rim-4', '--stats-glow-1', '--stats-glow-2', '--stats-card-shadow',
  '--chip-bg', '--chip-edge', '--chip-shadow'];

// ---------- token ----------
test('深绿卡 token：新的都在三块、旧的光球／玻璃／小卡 token 都拿掉', () => {
  for (const t of [light, mediaDark, attrDark]) {
    for (const n of NEW_TOKENS) assert.ok(t[n], `missing ${n}`);
    for (const n of GONE_TOKENS) assert.ok(!(n in t), `still has ${n}`);
  }
  for (const n of GONE_TOKENS) assert.ok(!css.includes(`var(${n})`), `still used: ${n}`);
  assert.equal(light['--card-1'], '#0F4A35');
  assert.equal(light['--card-2'], '#0A3526');
  assert.equal(light['--card-3'], '#062219');
  assert.equal(attrDark['--card-1'], '#0F4A35');
  assert.equal(light['--card-ink'], '#FFFFFF');
  assert.equal(light['--card-income'], '#BBD8FF');
  assert.equal(light['--card-fill'], '#C4E6D6');
});

// ---------- 共用外观 ----------
test('三张卡共用一条深绿规则：150deg 三段深绿＋两层光泽、字色 --card-ink、没有细纹', () => {
  const base = rules().find((r) => CARD_SEL.every((s) => selList(r.sel).includes(s)) && /var\(--card-1\)/.test(r.body));
  assert.ok(base, '找不到三张卡共用的深绿规则');
  assert.match(base.body, /linear-gradient\(150deg, var\(--card-1\) 0%, var\(--card-2\) 52%, var\(--card-3\) 100%\)/);
  assert.match(base.body, /var\(--card-sheen-mint\)/);
  assert.match(base.body, /var\(--card-sheen-white\)/);
  assert.match(base.body, /color:\s*var\(--card-ink\)/);
  assert.match(base.body, /box-shadow:\s*var\(--card-shadow\)/);
  assert.match(base.body, /isolation:\s*isolate/);
  assert.ok(!/repeating-/.test(css), '卡片不要细纹');
});

test('反向扫描：卡片家族的规则只用 --card-* 的字色，不混进页面的黑字／蓝字／细线', () => {
  const family = /\.(home-card|home-balance|home-flow|home-meter|home-float|stats-summary|stats-sum|wl-card|wl-amt|wl-flow|wl-bar)\b/;
  const bad = /var\(--(ink|ink-2|ink-3|income|hairline|track|label|secondary-label)\)/;
  const offenders = rules().filter((r) => family.test(r.sel) && !/home-card-wrap/.test(r.sel) && bad.test(r.body))
    .map((r) => `${r.sel} → ${r.body.match(bad)[0]}`);
  assert.deepEqual(offenders, []);
});

// ---------- 对比度：卡底叠上两层光泽的最亮处 ----------
for (const theme of ['light', 'dark']) {
  for (const stop of ['--card-1', '--card-2', '--card-3']) {
    for (const fg of ['--card-ink', '--card-ink-2', '--card-ink-dec', '--card-income']) {
      test(`${theme} ${fg} 压在 ${stop}＋光泽 ≥ 4.5`, () => {
        let bg = color(theme, stop).rgb;
        for (const sheen of ['--card-sheen-white', '--card-sheen-mint']) { const s = color(theme, sheen); bg = over(bg, s.rgb, s.a); }
        const f = color(theme, fg);
        const r = ratio(over(bg, f.rgb, f.a), bg);
        assert.ok(r >= 4.5, `${r.toFixed(2)} < 4.5`);
      });
    }
  }
}

// ---------- 首页卡版面 ----------
test('首页卡：信用卡比例、flex 直排、收入支出沉底可换行；不能裁切（长金额会把卡撑高）', () => {
  const card = blockAfter(css, '\n.home-card {');
  assert.match(card, /aspect-ratio:\s*1\.586/);
  assert.match(card, /display:\s*flex/);
  assert.match(card, /flex-direction:\s*column/);
  assert.ok(!/(^|[\s;])(height|max-height|overflow|contain)\s*:/.test(card), '不能有固定高度、overflow、contain');
  for (const r of rules().filter((x) => selList(x.sel).includes('.home-card'))) {
    assert.ok(!/(^|[\s;])(height|max-height|overflow[-\w]*|contain)\s*:/.test(r.body), `${r.sel} 不能裁切`);
  }
  const flow = blockAfter(css, '\n.home-flow {');
  assert.match(flow, /margin-top:\s*auto/);
  assert.match(flow, /flex-wrap:\s*wrap/);
  // 宽屏（iPad、桌面）不维持卡片比例，免得卡片太高
  assert.match(css, /@media \(min-width: 600px\) \{\s*\.home-card \{ aspect-ratio: auto; \}/);
});

test('首页卡：比例文字平常只给读屏（不是 display:none），超支时 .is-shown 才显示', () => {
  const note = blockAfter(css, '\n.home-meter-note {');
  assert.match(note, /clip-path:\s*inset\(50%\)/);
  assert.ok(!/display:\s*none/.test(note));
  const shown = blockAfter(css, '\n.home-meter-note.is-shown {');
  assert.match(shown, /clip-path:\s*none/);
  assert.match(shown, /position:\s*static/);
});

test('首页卡：眼睛的焦点框在深绿上看得见', () => {
  assert.match(css, /\.home-card > \.home-eye:focus-visible \{[^}]*outline-color:\s*var\(--card-ink\)/);
});

// ---------- 卡后光晕 ----------
test('首页卡后光晕：单一 radial、在卡片后面、相对卡片定位（不往上伸）、静态', () => {
  const g = blockAfter(css, '\n.home-card-wrap::before {');
  const grads = [...g.matchAll(/radial-gradient\(/g)];
  assert.equal(grads.length, 1);
  assert.match(g, /var\(--card-glow\), transparent 70%\)/);
  assert.match(g, /z-index:\s*-1/);
  assert.match(g, /pointer-events:\s*none/);
  assert.ok(!/animation|transition|filter/.test(g));
  const top = g.match(/\btop:\s*([^;]+);/)[1].trim();
  assert.ok(/^\d+(\.\d+)?%$/.test(top), `top 要用百分比且不为负：${top}`);
  assert.match(g, /\bleft:\s*0;/);
  assert.match(g, /\bright:\s*0;/);
});

test('欢迎页光晕：单一 radial、--card-glow', () => {
  const g = blockAfter(css, '\n.wl-hero::before {');
  assert.equal([...g.matchAll(/radial-gradient\(/g)].length, 1);
  assert.match(g, /var\(--card-glow\), transparent 70%\)/);
});

// ---------- 统计页 ----------
test('统计页：玻璃卡拆掉——摘要卡走深绿卡、走势图卡是白面板；光晕与玻璃分段控件都拿掉', () => {
  assert.ok(!/\.glass-card/.test(css), '.glass-card 规则应已拆掉');
  assert.ok(!css.includes('.stats-month::after'), '统计页光晕应已拆掉');
  assert.ok(!css.includes('.stats-body .segmented'), '统计页玻璃分段控件应已拆掉');
  const trend = blockAfter(css, '\n.trend-card {');
  assert.match(trend, /background:\s*var\(--drawer\)/);
  assert.match(trend, /box-shadow:\s*0 0 0 1px var\(--hairline\), var\(--panel-shadow\)/);
  for (const r of rules().filter((x) => /\.stats-sum-item \+ \.stats-sum-item/.test(x.sel))) {
    assert.match(r.body, /var\(--card-line\)/, r.sel);
  }
  assert.match(css, /\.stats-sum-v\.is-income \{[^}]*color:\s*var\(--card-income\)/);
});

// ---------- 欢迎页小卡 ----------
test('欢迎页账单小卡：白面板＋淡框（不再半透明）', () => {
  const tx = blockAfter(css, '\n.wl-tx {');
  assert.match(tx, /background:\s*var\(--drawer\)/);
  assert.match(tx, /box-shadow:\s*0 0 0 1px var\(--hairline\), var\(--panel-shadow\)/);
});

// ---------- 增加对比度 / 降低透明度 ----------
test('增加对比度／降低透明度：光晕与反光边关掉，卡片维持深绿（不改成 --glass）', () => {
  const marker = '@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {\n  .home-card-wrap::before';
  const i = css.indexOf(marker);
  assert.ok(i >= 0, 'fallback block');
  const block = css.slice(i, css.indexOf('\n}', i));
  for (const s of ['.home-card-wrap::before', '.home-card::before', '.stats-summary::before', '.wl-card::before', '.wl-hero::before']) {
    assert.ok(block.includes(s), s);
  }
  assert.match(block, /display:\s*none/);
  assert.ok(!/var\(--glass\)/.test(block), '卡片不改成玻璃色');
});
