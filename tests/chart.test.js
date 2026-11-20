import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monotonePath, snapDay, trendLabel, CHART } from '../js/chart.js';

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
