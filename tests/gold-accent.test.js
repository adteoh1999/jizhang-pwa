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
import { readFileSync } from 'node:fs';
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
