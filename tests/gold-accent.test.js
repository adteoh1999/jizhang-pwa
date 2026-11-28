// v3.7 金色强调色（用户 2026-11-28 选 B 经典金 #D9B45A）：金色只放 5 个小地方——
// 卡上结余小字、首页比例线尾端、卡片右下 1px 反光边、走势图圆点、统计分类条开头。白底上不放金字。
// 规格 docs/superpowers/specs/2026-11-28-gold-accent-design.md（§10 r2 为准）
import test from 'node:test';
import assert from 'node:assert/strict';
import { light, mediaDark, attrDark } from './helpers/css-tokens.js';

const GOLD = { '--gold': '#D9B45A', '--gold-deep': '#A98327', '--card-gold': '#EACF85', '--card-gold-edge': 'rgba(217, 180, 90, 0.6)' };
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ---------- token ----------
test('金色 token：三块都有且相同（深绿卡与金色在浅深色一样）', () => {
  for (const t of [light, mediaDark, attrDark]) {
    for (const [n, v] of Object.entries(GOLD)) assert.equal(t[n], v, n);
  }
});

test('走势图圆点 --chart-dot：浅色用深一阶的金（白底 ≥3），深色用 --gold', () => {
  assert.equal(light['--chart-dot'], 'var(--gold-deep)');
  for (const t of [mediaDark, attrDark]) assert.equal(t['--chart-dot'], 'var(--gold)');
});

test('卡片金边 --card-gold-edge 跟 --gold 同一个金，只是半透明 0.6', () => {
  const m = light['--card-gold-edge'].match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/);
  assert.ok(m, light['--card-gold-edge']);
  assert.deepEqual(m.slice(1, 4).map(Number), hexRgb(light['--gold']));
  assert.equal(Number(m[4]), 0.6);
});

// ---------- 卡上金字、金边、走势图金点 ----------
import { readFileSync, readdirSync } from 'node:fs';
import { css, blockAfter } from './helpers/css-tokens.js';

const statsJs = readFileSync(new URL('../js/ui/stats-view.js', import.meta.url), 'utf8');
/** 最内层的规则：[{ sel, body }]（@media 里的也算；选择器已去头尾空白） */
const rules = () => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const selList = (sel) => sel.split(',').map((s) => s.trim());
const ruleFor = (sel) => rules().filter((r) => selList(r.sel).includes(sel));

test('卡上金字：首页「本月结余」、统计「结余」、欢迎页示意卡「本月结余」都用 --card-gold', () => {
  const home = blockAfter(css, '\n.home-card-label {');
  assert.match(home, /color:\s*var\(--card-gold\)/);
  assert.match(home, /letter-spacing:\s*0\.04em/);
  assert.ok(ruleFor('.stats-sum-item:last-child .stats-sum-k').some((r) => /color:\s*var\(--card-gold\)/.test(r.body)), '统计结余标签');
  assert.match(blockAfter(css, '\n.wl-card-label {'), /color:\s*var\(--card-gold\)/);
});

test('统计摘要最后一格是「结余」（.stats-sum-item:last-child 选择器靠这个顺序）', () => {
  assert.match(statsJs, /cell\('收入', incomeEl, incomeSr\), cell\('支出', expenseEl, expenseSr\), cell\('结余', balanceEl, balanceSr\)\)/);
});

test('卡片 1px 反光边：右下那一端是金（--card-gold-edge），不再是薄荷', () => {
  const edge = rules().find((r) => ['.home-card::before', '.stats-summary::before', '.wl-card::before'].every((s) => selList(r.sel).includes(s)) && /mask/.test(r.body));
  assert.ok(edge, '三卡共用的反光边规则');
  assert.match(edge.body, /background:\s*linear-gradient\(140deg,[^;]*,\s*var\(--card-gold-edge\)\);/);
  assert.ok(!edge.body.includes('rgba(196, 230, 214, 0.26)'), '薄荷端已换掉');
});

test('走势图圆点（滑杆标记）与单点都用 --chart-dot；圆点白描边不变', () => {
  assert.match(blockAfter(css, '\n.trend-mdot {'), /fill:\s*var\(--chart-dot\);\s*stroke:\s*var\(--drawer\)/);
  assert.match(blockAfter(css, '\n.trend-single {'), /fill:\s*var\(--chart-dot\)/);
});

// ---------- 首页比例线：6px、亮光；「薄荷光照不到比例线」的前提 ----------
const homeJs = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
const loginJs = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
const SHEEN = 'inset 0 1px 0 rgba(255, 255, 255, 0.28)';

test('前提：右上薄荷光泽纵向只照到卡高一半以内（纵向半径 × 透明停靠点 ≤ 0.5）', () => {
  const card = rules().find((r) => ['.home-card', '.stats-summary', '.wl-card'].every((s) => selList(r.sel).includes(s)) && /var\(--card-1\)/.test(r.body));
  assert.ok(card, '三卡共用的深绿规则');
  const m = card.body.match(/radial-gradient\((\d+)% (\d+)% at 100% 0%, var\(--card-sheen-mint\), transparent (\d+)%\)/);
  assert.ok(m, '薄荷光泽写法改了：请重新确认比例线那一排照不到（tests/meter-gradient 比例线尾端模型）');
  assert.ok((Number(m[2]) / 100) * (Number(m[3]) / 100) <= 0.5, `纵向 ${m[2]}% × ${m[3]}%`);
});

test('前提：比例线是首页卡最后一个子元素、假比例线是欢迎页示意卡最后一个子元素（都在卡片下半部）', () => {
  const a = homeJs.indexOf("const summary = h('section', { class: 'home-card'");
  assert.ok(a >= 0, 'home-card 建立处');
  const b = homeJs.indexOf('meterNote));', a);
  assert.ok(b > a, 'home-card 结尾');
  assert.ok(homeJs.slice(a, b + 'meterNote));'.length).endsWith("h('div', { class: 'home-meter' }, meterBar, meterNote));"));
  const c = loginJs.indexOf("h('div', { class: 'wl-card' },");
  assert.ok(c >= 0, 'wl-card 建立处');
  const d = loginJs.indexOf("h('div', { class: 'wl-bar' }, h('i'))));", c);
  assert.ok(d > c, 'wl-bar 在 wl-card 里且是最后一个（后面接着关掉 wl-card 与 wl-layer）');
  assert.ok(!/class: 'wl-/.test(loginJs.slice(d + "h('div', { class: 'wl-bar' }".length, loginJs.indexOf(';', d))), 'wl-bar 后面没有别的卡内元素');
});

test('首页比例线：6px 高、全圆角、上距 14px；填充条与补缝段都有一道很淡的上缘亮光', () => {
  assert.match(blockAfter(css, '\n.home-meter {'), /margin-top:\s*14px/);
  const bar = blockAfter(css, '\n.home-meter-bar {');
  assert.match(bar, /height:\s*6px/);
  assert.match(bar, /border-radius:\s*3px/);
  const fill = blockAfter(css, '\n.home-meter-fill {');
  assert.match(fill, /border-radius:\s*0 3px 3px 0/);
  assert.ok(fill.includes(`box-shadow: ${SHEEN}`), 'fill 亮光');
  assert.ok(blockAfter(css, '\n.home-meter-fill::before {').includes(`box-shadow: ${SHEEN}`), '::before 亮光（回弹时补缝段也有）');
});

test('欢迎页假比例线跟真卡一样：6px、全圆角、同样的亮光', () => {
  const bar = blockAfter(css, '\n.wl-bar {');
  assert.match(bar, /height:\s*6px/);
  assert.match(bar, /border-radius:\s*3px/);
  assert.ok(blockAfter(css, '\n.wl-bar i {').includes(`box-shadow: ${SHEEN}`));
});

// ---------- 金色只放在指定的地方（面积越小越有印象；白底不放金字） ----------
const TOKEN_SEL = [':root', ':root:not([data-theme="light"])', ':root[data-theme="dark"]'];
const ALLOW = {
  '--gold': [], '--gold-deep': [],   // 只在 token 里被别的 token 引用
  '--card-gold': ['.home-card-label', '.stats-sum-item:last-child .stats-sum-k', '.wl-card-label',
    '.home-meter-fill', '.home-meter-fill::before', '.wl-bar i'],   // 后三个只在增加对比度时
  '--card-gold-edge': ['.home-card::before', '.stats-summary::before', '.wl-card::before'],
  '--chart-dot': ['.trend-mdot', '.trend-single'],
  '--meter-to': ['.home-meter-fill', '.wl-bar i'],
  '--bar-from': ['.stats-bar-fill', '.stats-bar-fill::before'],
};
const notToken = () => rules().filter((r) => !TOKEN_SEL.includes(r.sel));
/** var(--x) 或 var( --x , 后备值)：名称后面接空白、逗号或「)」才算（--gold 不会吃到 --gold-deep）。审核 I-1② */
const usesVar = (tok) => new RegExp(`var\\(\\s*${tok}\\s*[,)]`);
const GOLD_LITERAL = /#D9B45A|#EACF85|#A98327|#D7B157|217,\s*180,\s*90/i;

test('金色 token 只出现在指定的选择器（不管是 color、background、fill 还是 border，含带后备值的写法）', () => {
  const bad = [];
  for (const r of notToken()) {
    for (const [tok, allow] of Object.entries(ALLOW)) {
      if (!usesVar(tok).test(r.body)) continue;
      for (const s of selList(r.sel)) if (!allow.includes(s)) bad.push(`${s} 用了 ${tok}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('金色不能借别的 token 转手：token 块里引用金色（token 或色号）的只有指定那几个', () => {
  // 审核 I-1①：例如在 :root 加「--btn-bg: var(--gold)」再拿去别处用，上面那条看不到
  const OK = ['--gold', '--gold-deep', '--card-gold', '--card-gold-edge', '--meter-to', '--bar-from', '--chart-dot'];
  const refsGold = (v) => Object.keys(ALLOW).some((tok) => usesVar(tok).test(v)) || GOLD_LITERAL.test(v);
  const bad = [];
  for (const [label, t] of [['浅', light], ['深 media', mediaDark], ['深 attr', attrDark]]) {
    for (const [n, v] of Object.entries(t)) if (refsGold(v) && !OK.includes(n)) bad.push(`${label} ${n}: ${v}`);
  }
  assert.deepEqual(bad, []);
});

test('JS 与 index.html、manifest 里没有金色（色号或金色 token 名）：金色只在 app.css 的 token', () => {
  // 审核 I-1③：行内样式、SVG fill 属性不在 CSS 扫描范围
  const root = new URL('../', import.meta.url);
  const files = readdirSync(new URL('js/', root), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)
    .concat(['index.html', 'manifest.webmanifest']);
  assert.ok(files.length > 20, `扫到的档案太少：${files.length}`);
  const re = new RegExp(`${GOLD_LITERAL.source}|--gold\\b|--card-gold|--chart-dot`, 'i');
  assert.deepEqual(files.filter((f) => re.test(readFileSync(new URL(f, root), 'utf8'))), []);
});

test('金色字面值只在 token 块（规则里一律用 token）', () => {
  const bad = notToken().filter((r) => GOLD_LITERAL.test(r.body)).map((r) => r.sel);
  assert.deepEqual(bad, []);
});

test('白底上不放金字：字色（color）用到金色的只有深绿卡上三个「结余」标签', () => {
  const re = /(^|[\s;])color:\s*var\(\s*--(gold|gold-deep|card-gold|card-gold-edge|chart-dot|meter-to|bar-from)\s*[,)]/;
  const sels = notToken().filter((r) => re.test(r.body)).flatMap((r) => selList(r.sel)).sort();
  assert.deepEqual(sels, ['.home-card-label', '.stats-sum-item:last-child .stats-sum-k', '.wl-card-label'].sort());
});
