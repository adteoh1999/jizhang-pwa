// 统计页：月份切换器、当月摘要、支出/收入分类占比清单（横向比例条）。
// 选中的月份与类型只存在记忆体（切换分页时保留）。
import { h } from './dom.js';
import { icon } from './icons.js';
import { kindSegmented } from './components.js';
import { summarizeMonth, byCategory, formatPercent } from '../stats.js';
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

  // ---------- 摘要（沿用首页摘要卡样式） ----------
  const incomeEl = h('span', { class: 'home-summary-value is-income' });
  const expenseEl = h('span', { class: 'home-summary-value' });
  const balanceEl = h('span', { class: 'home-summary-value' });
  const row = (label, el) => h('div', { class: 'home-summary-row' },
    h('span', { class: 'home-summary-label' }, label), el);
  const summary = h('section', { class: 'home-summary stats-summary' },
    row('收入', incomeEl), row('支出', expenseEl), row('结余', balanceEl));

  // ---------- 支出 / 收入 ----------
  const seg = kindSegmented({ value: kind, onChange: (k) => setKind(k) });
  function setKind(k) {
    if (k === kind) return;
    kind = k;
    render();
  }

  const list = h('div', { class: 'stats-list' });
  root.replaceChildren(switcher, summary, seg.element, list);

  function render() {
    const now = monthOf(todayLocal());
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

    const rows = byCategory(all, month, kind);
    if (rows.length === 0) {
      list.replaceChildren(h('p', { class: 'stats-empty' },
        kind === 'expense' ? '这个月还没有支出记录' : '这个月还没有收入记录'));
      return;
    }
    list.replaceChildren(h('ul', { class: 'stats-group', role: 'list' }, rows.map((r) => {
      const cat = store.categoryById(r.category_id);
      const name = cat ? cat.name : '未分类';
      const pct = formatPercent(r.ratio);
      const bar = h('span', { class: 'stats-bar-fill' });
      bar.style.width = `max(6px, ${(r.ratio * 100).toFixed(2)}%)`;
      return h('li', { class: 'stats-row' },
        h('div', { class: 'stats-row-main' },
          h('span', { class: `home-row-icon${!cat || cat.deleted ? ' is-muted' : ''}` },
            icon(cat ? cat.icon : 'other', 20)),
          h('span', { class: 'stats-row-name' }, name),
          h('span', { class: 'stats-row-amount' }, formatRM(r.total, { sign: 'none' }))),
        h('div', { class: 'stats-row-sub' },
          h('span', { class: 'stats-bar', 'aria-hidden': 'true' }, bar),
          h('span', { class: 'stats-row-pct' }, pct)));
    })));
  }

  store.subscribe(render);
  const onWake = () => { if (document.visibilityState === 'visible') render(); };
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);

  render();
}
