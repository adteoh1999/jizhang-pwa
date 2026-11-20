// 统计：输入都是未删除的 Transaction 阵列
import { monthOf } from './dates.js';
import { timeValue } from './model.js';

export function summarizeMonth(txs, month) {
  let income = 0;
  let expense = 0;
  for (const t of txs) {
    if (monthOf(t.occurred_on) !== month) continue;
    if (t.kind === 'income') income += t.amount_minor;
    else if (t.kind === 'expense') expense += t.amount_minor;
  }
  return { income, expense, balance: income - expense };
}

/** 首页比例线：收入为 0 → none；支出超过收入 → over（满格）；否则 ratio（四舍五入整数百分比）。单位 sen。 */
export function spendMeter(income, expense) {
  if (!(income > 0)) return { state: 'none', pct: 0 };
  if (expense > income) return { state: 'over', pct: 100 };
  return { state: 'ratio', pct: Math.round((expense / income) * 100) };
}

export function byCategory(txs, month, kind) {
  const totals = new Map();
  let sum = 0;
  for (const t of txs) {
    if (t.kind !== kind || monthOf(t.occurred_on) !== month) continue;
    totals.set(t.category_id, (totals.get(t.category_id) || 0) + t.amount_minor);
    sum += t.amount_minor;
  }
  if (sum === 0) return [];
  return [...totals.entries()]
    .map(([category_id, total]) => ({ category_id, total, ratio: total / sum }))
    .sort((a, b) => b.total - a.total || (a.category_id < b.category_id ? -1 : a.category_id > b.category_id ? 1 : 0));
}

/**
 * 累计走势：回传长度 = 该月天数的阵列，第 d 天（索引 d-1）为 1..d 日的累计金额（sen）。
 * 本月（month === monthOf(today)）今天之后为 null；过去月份全是数字；未来月份全是 null。
 */
export function cumulativeByDay(txs, month, kind, today) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const thisMonth = monthOf(today);
  const lastDay = month < thisMonth ? days : month === thisMonth ? Number(today.slice(8, 10)) : 0;
  const daily = new Array(days).fill(0);
  for (const t of txs) {
    if (t.kind !== kind || monthOf(t.occurred_on) !== month) continue;
    daily[Number(t.occurred_on.slice(8, 10)) - 1] += t.amount_minor;
  }
  let acc = 0;
  return daily.map((v, i) => {
    acc += v;
    return i < lastDay ? acc : null;
  });
}

const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

// 日期新→旧；同日 created_at 新→旧，再以 id 保证顺序固定
export function compareTx(a, b) {
  return cmpDesc(a.occurred_on, b.occurred_on)
    || cmpDesc(timeValue(a.created_at), timeValue(b.created_at))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function groupByDate(txs) {
  const groups = new Map();
  for (const t of [...txs].sort(compareTx)) {
    let g = groups.get(t.occurred_on);
    if (!g) {
      g = { date: t.occurred_on, items: [], net: 0 };
      groups.set(t.occurred_on, g);
    }
    g.items.push(t);
    g.net += t.kind === 'income' ? t.amount_minor : -t.amount_minor;
  }
  return [...groups.values()];
}

/** 百分比显示：极小占比显示「<1%」；四舍五入到 100 但并非全部时显示「99%」。 */
export function formatPercent(ratio) {
  if (ratio > 0 && ratio < 0.005) return '<1%';
  const p = Math.round(ratio * 100);
  if (p >= 100 && ratio < 1) return '99%';
  return `${p}%`;
}
