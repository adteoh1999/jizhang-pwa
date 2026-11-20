// 累计走势图卡：标题「累计支出 / 累计收入」+ 右侧「累计 RM x」、SVG 曲线、X 轴刻度、空状态。
// 图表本身是一个滑杆（role=slider）：左右键 / VoiceOver 上下滑逐日移动；手指水平拖动逐日吸附。
// 效能：资料变动时才重画曲线；拖动只改标记（竖线 + 圆点）与黑色标签的属性。
import { h } from './dom.js';
import { CHART, dayX, monotonePath, snapDay, trendLabel, trendState } from '../chart.js';
import { formatRM } from '../money.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LOCK_DIST = 10;   // 判断方向前要移动的距离（同首页左滑删除）
const TIP_GAP = 12;     // 标签底边与圆点之间的距离（CSS px）
let uid = 0;

function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * mountTrendChart(container, { onChangeText? }) → { update({ values, month, kind }), element }
 * values：cumulativeByDay 的结果（今天之后为 null）。onChangeText(text)：选中日变动时呼叫。
 */
export function mountTrendChart(container, { onChangeText } = {}) {
  const { W, H, PL, PR, PT, PB } = CHART;
  const base = H - PB;
  const gradId = `trend-fade-${++uid}`;

  const titleEl = h('span', { class: 'trend-title' });
  const totalEl = h('span', { class: 'trend-total' });

  const stop0 = s('stop', { offset: 0, class: 'trend-stop0' });
  const stop1 = s('stop', { offset: 1, class: 'trend-stop1' });
  const grad = s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(stop0, stop1);
  const defs = s('defs');
  defs.append(grad);
  const baseLine = s('line', { class: 'trend-base', y1: base, y2: base, x1: PL });
  const futureLine = s('line', { class: 'trend-future', y1: base, y2: base, x2: W - PR });
  const area = s('path', { class: 'trend-area', fill: `url(#${gradId})` });
  const line = s('path', { class: 'trend-line' });
  const single = s('circle', { class: 'trend-single', r: 4 });
  const mLine = s('line', { class: 'trend-mline', y1: PT - 8, y2: base });
  const mDot = s('circle', { class: 'trend-mdot', r: 5 });
  const marker = s('g', { class: 'trend-marker' });
  marker.append(mLine, mDot);

  const svg = s('svg', {
    class: 'trend-svg', viewBox: `0 0 ${W} ${H}`, role: 'slider', tabindex: 0,
    'aria-valuemin': 1,
  });
  svg.append(defs, baseLine, futureLine, area, line, single, marker);
  const tip = h('div', { class: 'trend-tip', 'aria-hidden': 'true' });
  const box = h('div', { class: 'trend-box' }, svg, tip);
  const axis = h('div', { class: 'trend-axis', 'aria-hidden': 'true' });
  const empty = h('p', { class: 'trend-empty', hidden: true });
  const element = h('section', { class: 'glass-card trend-card' },
    h('div', { class: 'trend-head' }, titleEl, totalEl), box, axis, empty);
  container.append(element);

  let month = '';
  let kind = '';
  let values = [];
  let days = 30;
  let lastDay = 0;
  let pts = [];
  let sel = 0;
  let lastText = '';
  let boxW = 0;  // 图表盒宽（CSS px）快取：ResizeObserver 更新
  let tipW = 0;  // 标签宽：文字改变后重量
  let tipH = 0;  // 标签高：字级改变（resize）后重量
  let g = null;  // 手势 { pid, x0, y0, state: 'pending'|'drag', left, width }

  function renderAxis() {
    const ticks = [1, 8, 15, 22, days];
    axis.replaceChildren(...ticks.map((d, i) => {
      const el = h('span', { class: 'trend-tick' }, i === 0 ? '1 日' : String(d));
      el.style.left = `${((dayX(d, days) / W) * 100).toFixed(2)}%`;
      return el;
    }));
  }

  // 只改标记与标签：不重画曲线。拖动中只写属性；标签宽度只在文字改变时量一次，盒宽用快取。
  function place(day) {
    if (!lastDay || !pts.length) { g = null; return; } // 拖动中资料变空 → 结束手势
    sel = Math.min(Math.max(1, day), lastDay);
    const [x, y] = pts[sel - 1];
    mLine.setAttribute('x1', x.toFixed(1));
    mLine.setAttribute('x2', x.toFixed(1));
    mDot.setAttribute('cx', x.toFixed(1));
    mDot.setAttribute('cy', y.toFixed(1));
    const text = trendLabel(month, sel, values[sel - 1]);
    if (text !== lastText) {
      lastText = text;
      tip.textContent = text;
      tipW = 0; // 文字改了 → 下次摆放时重量宽度
      svg.setAttribute('aria-valuenow', String(sel));
      svg.setAttribute('aria-valuetext', text);
      if (onChangeText) onChangeText(text);
    }
    positionTip();
  }

  // 标签置中在圆点上方，贴边时夹在图内；盒宽 0（分页隐藏中）时等 ResizeObserver 再算
  function positionTip() {
    if (!boxW || !pts.length) return;
    if (!tipW) { tipW = tip.offsetWidth; tipH = tipH || tip.offsetHeight; }
    const scale = boxW / W;
    const [x, y] = pts[sel - 1];
    const left = Math.min(Math.max(x * scale - tipW / 2, 0), Math.max(0, boxW - tipW));
    const top = Math.max(0, y * scale - tipH - TIP_GAP);
    tip.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
  }

  function update(next) {
    const changed = next.month !== month || next.kind !== kind;
    const wasAtEnd = sel === lastDay;
    ({ month, kind, values } = next);
    const label = kind === 'income' ? '累计收入' : '累计支出';
    titleEl.textContent = label;
    svg.setAttribute('aria-label', label);
    const newDays = values.length;
    if (newDays !== days || !axis.childElementCount) { days = newDays; renderAxis(); }

    // hasRecords（这个月这一类有没有记录）由呼叫端提供；只有未来日期的记录 → 贴底平线
    const hasRecords = next.hasRecords ?? values.some((v) => v > 0);
    const st = trendState(values, hasRecords);
    const isEmpty = st.mode === 'empty';
    box.hidden = isEmpty;
    axis.hidden = isEmpty;
    empty.hidden = !isEmpty;
    totalEl.hidden = isEmpty;
    if (isEmpty) {
      empty.textContent = kind === 'income' ? '这个月还没有收入记录' : '这个月还没有支出记录';
      lastDay = 0;
      pts = [];
      sel = 0;
      lastText = '';
      g = null;
      return;
    }
    tipW = 0; // 字级（Dynamic Type）可能已变 → 重量标签尺寸
    tipH = 0;
    lastDay = st.lastDay;
    totalEl.textContent = `累计 ${formatRM(st.total, { sign: 'none' })}`;
    if (!boxW) boxW = box.clientWidth; // 显示中才有值；隐藏时等 ResizeObserver

    pts = st.ys.map((y, i) => [dayX(i + 1, days), y]);
    const xLast = pts[lastDay - 1][0];
    baseLine.setAttribute('x2', xLast.toFixed(1));
    futureLine.setAttribute('x1', xLast.toFixed(1));
    futureLine.style.display = lastDay < days ? '' : 'none';

    const d = st.mode === 'line' ? monotonePath(pts) : '';
    line.setAttribute('d', d);
    area.setAttribute('d', d ? `${d} L${xLast.toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z` : '');
    single.style.display = d ? 'none' : '';
    if (!d) {
      single.setAttribute('cx', pts[0][0].toFixed(1));
      single.setAttribute('cy', pts[0][1].toFixed(1));
    }
    svg.setAttribute('aria-valuemax', String(lastDay));
    // 预设停在最后有值的那天；同一张图资料变动时保留位置（原本在最后一天就继续跟着最后一天）
    place(changed || wasAtEnd || !sel ? lastDay : sel);
  }

  // ---------- 键盘 / VoiceOver（WebKit 的 increment / decrement 会送方向键） ----------
  svg.addEventListener('keydown', (e) => {
    if (!lastDay) return;
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (step) place(sel + step);
    else if (e.key === 'Home') place(1);
    else if (e.key === 'End') place(lastDay);
    else return;
    e.preventDefault();
  });

  // ---------- 拖动：方向锁定（偏垂直 → 放弃，让页面捲动），touch-action: pan-y ----------
  const dayAt = (e) => snapDay(e.clientX - g.left, g.width, days, lastDay);
  svg.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || !lastDay || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const r = box.getBoundingClientRect(); // 手势开始时量一次；拖动中不再读版面
    boxW = r.width;
    g = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, state: 'pending', left: r.left, width: r.width };
    if (e.pointerType === 'mouse') { // 滑鼠不会捲动页面：直接开始
      g.state = 'drag';
      try { svg.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      place(dayAt(e));
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.pid) return;
    if (g.state === 'pending') {
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (Math.hypot(dx, dy) < LOCK_DIST) return;
      if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // 偏垂直 → 交给页面捲动
      g.state = 'drag';
      try { svg.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    }
    place(dayAt(e));
  });
  svg.addEventListener('pointerup', (e) => {
    if (!g || e.pointerId !== g.pid) return;
    if (g.state === 'pending') place(dayAt(e)); // 轻点：跳到那一天
    g = null;                                    // 放开后停在该日
  });
  svg.addEventListener('pointercancel', (e) => { if (g && e.pointerId === g.pid) g = null; });

  // 分页从隐藏变显示、旋转、字级改变 → 重新摆标签
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver((entries) => {
      boxW = entries[entries.length - 1].contentRect.width;
      tipW = 0;
      tipH = 0;
      positionTip();
    }).observe(box);
  }

  return { update, element };
}
