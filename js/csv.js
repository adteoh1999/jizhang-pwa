// CSV 导出 / 解析 / 导入规划
import { minorToDecimalString, parseAmount } from './money.js';
import { isValidDateString } from './dates.js';
import { buildTransaction, buildCategory, timeValue, ValidationError } from './model.js';
import { compareTx } from './stats.js';
import { isUuid } from './timefmt.js';

export const CSV_HEADER = ['id', 'date', 'kind', 'amount', 'category', 'note', 'updated_at'];

function esc(v) {
  const s = String(v);
  if (/[",\r\n]/.test(s) || s !== s.trim()) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 3f 防公式：Excel／Numbers 会把 = + - @ Tab CR LF 开头的格子当公式。导出时前面加一个 '（可逆：
// 原本就是若干个 ' 接公式字元的也再加一个），导入时同样条件去掉一个。只套用户打的字（备注、分类名）。
const FORMULA_LEAD = /^'*[=+\-@\t\r\n]/;
export function csvGuard(s) {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}
export function csvUnguard(s) {
  return s.startsWith("'") && FORMULA_LEAD.test(s) ? s.slice(1) : s;
}

export function toCSV(txs, categoriesById) {
  const rows = txs.filter((t) => !t.deleted).sort(compareTx).map((t) => [
    t.id, t.occurred_on, t.kind, minorToDecimalString(t.amount_minor),
    csvGuard(categoriesById.get(t.category_id)?.name ?? '未分类'), csvGuard(t.note), t.updated_at,
  ]);
  return '\ufeff' + [CSV_HEADER, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; }
    else if (c === ',') { row.push(cell); cell = ''; i++; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else { cell += c; i++; }
  }
  if (inQ) throw new Error('CSV 格式不对：引号没有闭合');
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function normDate(s) {
  s = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y; let mo; let d;
  if (m) [, y, mo, d] = m;
  else if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) [, y, mo, d] = m;
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [, d, mo, y] = m;
  else return null;
  const out = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidDateString(out) ? out : null;
}

export function planImport(rows, { existingTxs, categories, now, uuid }) {
  const REQUIRED = ['date', 'kind', 'amount'];
  const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  if (!REQUIRED.every((k) => k in col)) throw new Error('CSV 格式不对：缺少必要栏位');
  const cell = (r, k) => (k in col && r[col[k]] !== undefined ? r[col[k]] : '');

  const newCategories = [];
  const catByKey = new Map(); // `${kind}\n${name}` -> 未删除分类
  const maxSort = { expense: -1, income: -1 };
  for (const c of categories) {
    if (!c.deleted) catByKey.set(`${c.kind}\n${c.name}`, c);
    if (c.sort > maxSort[c.kind]) maxSort[c.kind] = c.sort;
  }

  const txs = [];
  const seenIds = new Set();
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((v) => String(v).trim() === '')) continue; // 空白行
    const rowIndex = i - 1;
    const skip = () => { skipped++; };

    const currency = cell(r, 'currency').trim();
    if (currency !== '' && currency.toUpperCase() !== 'MYR') { skip(); continue; }
    const kind = cell(r, 'kind').trim().toLowerCase();
    if (kind !== 'expense' && kind !== 'income') { skip(); continue; }
    const amount = parseAmount(cell(r, 'amount').trim());
    const date = normDate(cell(r, 'date'));
    if (amount === null || date === null) { skip(); continue; }

    // id：原样等于本机某笔的 key（旧版导入留下的非 uuid / 大写 id）→ 当成同一笔，导出再导入不会重复；
    // 否则合法 uuid 一律小写，非 uuid（手改过的档）当成没有 id：换新 uuid、不比对已存在。
    const rawId = cell(r, 'id').trim();
    const id = rawId !== '' && existingTxs.has(rawId) ? rawId : isUuid(rawId) ? rawId.toLowerCase() : '';
    const existing = id !== '' ? existingTxs.get(id) : undefined;
    if (id !== '' && seenIds.has(id)) { skip(); continue; }
    if (existing && !existing.deleted
      && !(timeValue(cell(r, 'updated_at').trim()) > timeValue(existing.updated_at))) { skip(); continue; }

    // 先 trim → 再去掉导出时加的 '（3f）→ 才查分类、验长度
    const catName = csvUnguard(cell(r, 'category').trim()) || '未分类';
    const key = `${kind}\n${catName}`;
    let cat = catByKey.get(key);
    let pendingCat = null;
    if (!cat) {
      try {
        pendingCat = buildCategory({ name: catName, kind, sort: maxSort[kind] + 1 }, null, { now, uuid });
      } catch (e) {
        if (e instanceof ValidationError) { skip(); continue; }
        throw e;
      }
      cat = pendingCat;
    }

    let tx;
    try {
      tx = buildTransaction({
        id: id || undefined, kind, amountMinor: amount, categoryId: cat.id,
        occurredOn: date, note: csvUnguard(cell(r, 'note').trim()),
      }, existing || null, { now, uuid });
    } catch (e) {
      if (e instanceof ValidationError) { skip(); continue; }
      throw e;
    }
    tx.created_at = existing ? existing.created_at : new Date(now.getTime() - rowIndex).toISOString();
    if (pendingCat) {
      catByKey.set(key, pendingCat);
      newCategories.push(pendingCat);
      maxSort[kind] = pendingCat.sort;
    }
    if (id !== '') seenIds.add(id);
    txs.push(tx);
  }
  return { txs, newCategories, imported: txs.length, skipped };
}
