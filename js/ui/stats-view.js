// 统计页：月份切换器、摘要玻璃卡、黑色胶囊支出/收入切换、累计走势图、分类占比抽屉（分类色比例条）。
// 选中的月份与类型只存在记忆体（切换分页时保留）。
import { h } from './dom.js';
import { icon, rowIconAttr } from './icons.js';
import { kindSegmented } from './components.js';
import { mountTrendChart } from './trend-chart.js';
import { summarizeMonth, byCategory, formatPercent, cumulativeByDay } from '../stats.js';
import { formatRM } from '../money.js';
import { todayLocal, monthOf, shiftMonth, formatMonthTitle } from '../dates.js';

export function mountStats(root, store) {
  let curMonth = monthOf(todayLocal()); // 上次渲染时的「本月」
  let month = curMonth;
  let kind = 'expense';

  // ---------- 月份切换器 ----------
  const title = h('h2', { class: 'stats-month-title', 'aria-live': 'polite' });
  const prevBtn = h('button', {
    type: 'button', class: 'stats-month-btn', 'aria-label': '上个月',
    on: { click: () => { month = shiftMonth(month, -1); render(); } },
  }, icon('chevron-left', 22));
  const nextBtn = h('button', {
    type: 'button', class: 'stats-month-btn', 'aria-label': '下个月',
    on: { click: () => { if (month < curMonth) { month = shiftMonth(month, 1); render(); } } },
  }, icon('chevron-right', 22));
  const switcher = h('div', { class: 'stats-month' }, prevBtn, title, nextBtn);

  // ---------- 摘要：小一号玻璃卡（无光晕） ----------
  const incomeEl = h('span', { class: 'stats-sum-v is-income' });
  const expenseEl = h('span', { class: 'stats-sum-v' });
  const balanceEl = h('span', { class: 'stats-sum-v' });
  const cell = (label, el) => h('div', { class: 'stats-sum-item' },
    h('span', { class: 'stats-sum-k' }, label), el);
  const summary = h('section', { class: 'glass-card stats-summary' },
    cell('收入', incomeEl), cell('支出', expenseEl), cell('结余', balanceEl));

  // ---------- 支出 / 收入 ----------
  const seg = kindSegmented({ value: kind, onChange: (k) => setKind(k) });
  function setKind(k) {
    if (k === kind) return;
    kind = k;
    render();
  }

  const chartSlot = h('div', { class: 'stats-chart' });
  const list = h('ul', { class: 'stats-group', role: 'list' });
  const drawerTotal = h('span', { class: 'home-drawer-count' }); // 整个月该类合计（可能含今天之后的记录）
  const drawer = h('section', { class: 'stats-drawer', 'aria-labelledby': 'stats-drawer-title' },
    h('div', { class: 'home-drawer-head' },
      h('h2', { class: 'home-drawer-title', id: 'stats-drawer-title' }, '分类'), drawerTotal),
    list);
  root.replaceChildren(switcher, summary, seg.element, chartSlot, drawer);
  const chart = mountTrendChart(chartSlot);

  function render() {
    const today = todayLocal();
    const now = monthOf(today);
    if (now !== curMonth) {
      if (month === curMonth) month = now; // 原本看着「本月」→ 跟到新的本月
      curMonth = now;
    }
    if (month > curMonth) month = curMonth;
    const titleText = formatMonthTitle(month);
    if (title.textContent !== titleText) title.textContent = titleText; // live region 只在变动时更新
    summary.setAttribute('aria-label', `收支摘要，${titleText}`);
    nextBtn.setAttribute('aria-disabled', month === curMonth ? 'true' : 'false');

    const all = store.transactions();
    const s = summarizeMonth(all, month);
    incomeEl.textContent = formatRM(s.income, { sign: 'none' });
    expenseEl.textContent = formatRM(s.expense, { sign: 'none' });
    balanceEl.textContent = formatRM(s.balance);

    seg.set(kind);

    // 单一来源：这个月这一类有没有记录 = byCategory 有没有列。
    // 没有 → 空状态文字只在走势图卡里显示，分类抽屉整个隐藏（不重复）；
    // 有（即使只有今天之后的日期）→ 走势图照画（到今天为 0 时是贴底的平线）。
    const rows = byCategory(all, month, kind);
    chart.update({ values: cumulativeByDay(all, month, kind, today), month, kind, hasRecords: rows.length > 0 });
    drawer.hidden = rows.length === 0;
    drawerTotal.textContent = `共 ${formatRM(rows.reduce((sum, r) => sum + r.total, 0), { sign: 'none' })}`;
    list.replaceChildren(...rows.map((r) => {
      const cat = store.categoryById(r.category_id);
      const name = cat ? cat.name : '未分类';
      const iconAttr = rowIconAttr(cat); // null → 灰色（已删除 / 未分类）
      const bar = h('span', { class: 'stats-bar-fill', 'data-icon': iconAttr });
      bar.style.width = `max(6px, ${(r.ratio * 100).toFixed(2)}%)`;
      return h('li', { class: 'stats-row' },
        h('span', { class: `home-row-icon${iconAttr ? '' : ' is-muted'}`, 'data-icon': iconAttr },
          icon(cat ? cat.icon : 'other', 22)),
        h('span', { class: 'stats-row-text' },
          h('span', { class: 'stats-row-name' }, name),
          h('span', { class: 'stats-bar', 'aria-hidden': 'true' }, bar)),
        h('span', { class: 'stats-row-nums' },
          h('span', { class: 'stats-row-amount' }, formatRM(r.total, { sign: 'none' })),
          h('span', { class: 'stats-row-pct' }, formatPercent(r.ratio))));
    }));
  }

  store.subscribe(render);
  const onWake = () => { if (document.visibilityState === 'visible') render(); };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);

  render();

  // 进入统计页（app.js 切分页时呼叫）：v2.3 Task 6 播走势线画出与分类条长出
  function enter() {}
  return { enter };
}
