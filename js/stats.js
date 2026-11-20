// 统计：输入都是未删除的 Transaction 阵列
import { monthOf } from './dates.js';

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

const cmpDesc = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

// 日期新→旧；同日 created_at 新→旧，再以 id 保证顺序固定
export function compareTx(a, b) {
  return cmpDesc(a.occurred_on, b.occurred_on)
    || cmpDesc(a.created_at, b.created_at)
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
