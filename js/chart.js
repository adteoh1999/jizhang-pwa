// 走势图纯函数：单调三次曲线、逐日吸附、标签文案。不碰 DOM。
import { formatRM } from './money.js';

/** 走势图的座标系（SVG viewBox 0 0 W H；上方留 PT 给黑色标签）。 */
export const CHART = { W: 340, H: 170, PL: 6, PR: 6, PT: 40, PB: 10 };

/** 第 day 天（1 起）在 viewBox 里的 x。 */
export function dayX(day, days) {
  return CHART.PL + ((day - 1) / Math.max(1, days - 1)) * (CHART.W - CHART.PL - CHART.PR);
}

const f1 = (n) => n.toFixed(1);

/**
 * Fritsch–Carlson 单调三次插值 → SVG path（M … C …，数字保留 1 位小数）。
 * points 的 x 必须递增。0 或 1 个点回传 ''（呼叫端自己画圆点）。
 * 内部切线用加权调和平均（相邻斜率异号或为 0 时取 0），控制点不会超出该段两端 y 的范围：
 * 不会冲到 0 以下，也不会出现资料里没有的高峰。
 */
export function monotonePath(points) {
  const n = points.length;
  if (n < 2) return '';
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0];
    m[i] = (points[i + 1][1] - points[i][1]) / dx[i];
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    t[i] = m[i - 1] * m[i] <= 0
      ? 0
      : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  }
  let d = `M${f1(points[0][0])} ${f1(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h3 = dx[i] / 3;
    d += ` C${f1(x0 + h3)} ${f1(y0 + t[i] * h3)} ${f1(x1 - h3)} ${f1(y1 - t[i + 1] * h3)} ${f1(x1)} ${f1(y1)}`;
  }
  return d;
}

/**
 * 指标位置 → 吸附到最近的一天，夹在 1..lastDay（不会跑到今天之后或月份以外）。
 * px：相对于图表盒子左缘的 CSS px；boxWidth：盒子宽（0 = 还没排版 → 回传 lastDay）。
 */
export function snapDay(px, boxWidth, days, lastDay) {
  if (!(boxWidth > 0)) return lastDay;
  const x = (px / boxWidth) * CHART.W;
  const d = Math.round(((x - CHART.PL) / (CHART.W - CHART.PL - CHART.PR)) * (days - 1)) + 1;
  return Math.min(Math.max(1, d), lastDay);
}

/**
 * 走势图状态（单一来源：hasRecords = 这个月这一类有没有记录，由 byCategory 判断）。
 * values：cumulativeByDay 的结果。回传 { mode: 'empty'|'dot'|'line', lastDay, total, ys }。
 * - 没有记录 → empty（图卡显示空状态文字）。
 * - 有记录但到今天累计仍是 0（只有未来日期的记录）→ 贴底的平线，不是空状态。
 * ys：每一天（1..lastDay）在 viewBox 里的 y；total 为 0 时一律贴底（不除以 0）。
 */
export function trendState(values, hasRecords) {
  let lastDay = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== null) lastDay = i + 1;
  const total = lastDay ? values[lastDay - 1] : 0;
  const base = CHART.H - CHART.PB;
  const ys = values.slice(0, lastDay)
    .map((v) => (total > 0 ? CHART.PT + (1 - v / total) * (base - CHART.PT) : base));
  const mode = !hasRecords || !lastDay ? 'empty' : lastDay === 1 ? 'dot' : 'line';
  return { mode, lastDay, total, ys };
}

/** 标签 / aria-valuetext：「11月18日 累计 RM 528.00」。 */
export function trendLabel(month, day, minor) {
  return `${Number(month.slice(5, 7))}月${day}日 累计 ${formatRM(minor, { sign: 'none' })}`;
}
