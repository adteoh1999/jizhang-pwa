import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monotonePath, snapDay, trendLabel, trendState, CHART, revealPercent } from '../js/chart.js';
import { cumulativeByDay } from '../js/stats.js';

// 解析 `M x y C c1x c1y c2x c2y x y …` → 每段 { y0, c1y, c2y, y1 }
function segments(d) {
  const nums = (str) => str.trim().split(/\s+/).map(Number);
  let y0 = nums(/^M([^C]+)/.exec(d)[1])[1];
  const out = [];
  for (const m of d.matchAll(/C([^C]+)/g)) {
    const [, c1y, , c2y, , y1] = nums(m[1]);
    out.push({ y0, c1y, c2y, y1 });
    y0 = y1;
  }
  return out;
}

test('monotonePath never overshoots between points', () => {
  const pts = [[0, 100], [10, 100], [20, 20], [30, 20], [40, 0]];
  const d = monotonePath(pts);
  const segs = segments(d);
  assert.equal(segs.length, 4);
  for (const seg of segs) { // 每段 C 的两个控制点 y 必须介于该段两端 y 之间
    assert.ok(seg.c1y >= Math.min(seg.y0, seg.y1) - 1e-9 && seg.c1y <= Math.max(seg.y0, seg.y1) + 1e-9);
    assert.ok(seg.c2y >= Math.min(seg.y0, seg.y1) - 1e-9 && seg.c2y <= Math.max(seg.y0, seg.y1) + 1e-9);
  }
});

test('monotonePath short inputs', () => {
  assert.equal(monotonePath([]), ''); assert.equal(monotonePath([[5, 5]]), '');
});

test('monotonePath two points and 1-decimal formatting', () => {
  assert.equal(monotonePath([[0, 10], [3, 1]]), 'M0.0 10.0 C1.0 7.0 2.0 4.0 3.0 1.0');
  for (const n of monotonePath([[0.123, 5.55], [7.77, 1.01], [9, 1]]).match(/-?\d+(\.\d+)?/g)) {
    assert.match(n, /^-?\d+\.\d$/);
  }
});

test('snapDay rounds to nearest day and never passes lastDay or month bounds', () => {
  const w = CHART.W; // 盒宽 = viewBox 宽（scale 1）
  const xAt = (d, days) => CHART.PL + ((d - 1) / (days - 1)) * (CHART.W - CHART.PL - CHART.PR);
  assert.equal(snapDay(xAt(18, 30), w, 30, 20), 18);
  assert.equal(snapDay(xAt(18, 30) + 4, w, 30, 20), 18);
  assert.equal(snapDay(xAt(25, 30), w, 30, 20), 20);   // 今天之后 → 吸附回今天
  assert.equal(snapDay(-50, w, 30, 20), 1);             // 月份以外（左）
  assert.equal(snapDay(w + 50, w, 31, 31), 31);         // 月份以外（右）
  assert.equal(snapDay(xAt(10, 30) * 2, w * 2, 30, 30), 10); // 盒子缩放
  assert.equal(snapDay(100, 0, 30, 20), 20);            // 盒宽 0（隐藏）→ 最后有值的那天
});

test('trendLabel copy', () => {
  assert.equal(trendLabel('2026-11', 18, 52800), '11月18日 累计 RM 528.00');
  assert.equal(trendLabel('2026-02', 1, 0), '2月1日 累计 RM 0.00');
  assert.equal(trendLabel('2026-12', 31, 123456789), '12月31日 累计 RM 1,234,567.89');
});

const tx = (occurred_on, kind, amount_minor) => ({
  id: `${occurred_on}-${amount_minor}`, occurred_on, kind, amount_minor, category_id: 'food',
  deleted: false, created_at: '2026-11-01T00:00:00.000Z',
});

test('trendState: only future-dated records this month → flat line, not empty', () => {
  const values = cumulativeByDay([tx('2026-11-25', 'expense', 5000)], '2026-11', 'expense', '2026-11-21');
  const st = trendState(values, true);
  assert.equal(st.mode, 'line');
  assert.equal(st.lastDay, 21);
  assert.equal(st.total, 0);
  assert.equal(st.ys.length, 21);
  assert.ok(st.ys.every((y) => y === CHART.H - CHART.PB)); // 平线贴底，没有 NaN
});

test('trendState: no records → empty; one day → dot; normal → line scaled to total', () => {
  assert.equal(trendState(cumulativeByDay([], '2026-11', 'expense', '2026-11-21'), false).mode, 'empty');
  const one = trendState(cumulativeByDay([tx('2026-12-01', 'expense', 500)], '2026-12', 'expense', '2026-12-01'), true);
  assert.equal(one.mode, 'dot'); assert.equal(one.lastDay, 1); assert.equal(one.ys[0], CHART.PT);
  const st = trendState(cumulativeByDay([tx('2026-10-02', 'expense', 100), tx('2026-10-31', 'expense', 300)],
    '2026-10', 'expense', '2026-11-21'), true);
  assert.equal(st.mode, 'line'); assert.equal(st.lastDay, 31); assert.equal(st.total, 400);
  assert.equal(st.ys[0], CHART.H - CHART.PB); assert.equal(st.ys[30], CHART.PT);
  assert.ok(st.ys.every((y) => Number.isFinite(y)));
});

test('revealPercent：走势线揭开的距离对到最后有值那天（占图宽 %）', () => {
  assert.equal(revealPercent(170, 340), 50);
  assert.equal(revealPercent(400, 340), 100);
  assert.equal(revealPercent(-1, 340), 0);
});

test('走势图拆层：线与渐层在 aria-hidden 的揭开层；统计页分类条用滑入、换月份有整块包装', async () => {
  const { readFileSync } = await import('node:fs');
  const tc = readFileSync(new URL('../js/ui/trend-chart.js', import.meta.url), 'utf8');
  assert.match(tc, /class: 'trend-reveal'/);
  assert.match(tc, /class: 'trend-art'/);
  assert.match(tc, /playReveal/);
  const sv = readFileSync(new URL('../js/ui/stats-view.js', import.meta.url), 'utf8');
  assert.ok(!/bar\.style\.width/.test(sv), '分类条不能再改 width');
  assert.match(sv, /slideX\(r\.ratio, 6\)/);
  assert.match(sv, /class: 'stats-body'/);
  assert.match(sv, /chart\.playReveal\(\)/);
});

test('走势图揭开层：内距放在里层（两层同宽，位移才相等）；连点换月份用序号；拖动时标记马上出现', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => { const i = css.indexOf(`\n${sel} {`); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  assert.ok(!/padding/.test(rule('.trend-reveal')), '外层不能有内距');
  assert.match(rule('.trend-reveal-in'), /padding:\s*4px/);
  assert.equal(css.split('\n.trend-svg {').length - 1, 1, '.trend-svg 只有一条规则');
  const sv = readFileSync(new URL('../js/ui/stats-view.js', import.meta.url), 'utf8');
  assert.match(sv, /const seq = \+\+switchSeq;/);
  assert.match(sv, /clipSupported\(\)/);
  assert.match(sv, /Math\.min\(i, 8\)/);
  const tc = readFileSync(new URL('../js/ui/trend-chart.js', import.meta.url), 'utf8');
  assert.match(tc, /function stopReveal\(/);
  assert.ok((tc.match(/stopReveal\(\)/g) || []).length >= 3, 'update（换月）、拖动、键盘都要停掉揭开');
});
