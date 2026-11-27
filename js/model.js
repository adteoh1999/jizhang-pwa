// 纪录模型：默认分类、纪录建构、验证
import { MAX_MINOR } from './money.js';
import { isValidDateString } from './dates.js';

export const DEFAULT_EPOCH = '1970-01-01T00:00:00.000Z';
export const NOTE_MAX = 500;
export const CATEGORY_NAME_MAX = 30;
const KINDS = ['expense', 'income'];

const mk = (kind, list) => list.map(([id, name], sort) => Object.freeze({
  id, kind, name, icon: id, sort, updated_at: DEFAULT_EPOCH, deleted: false, dirty: 0,
}));

export const DEFAULT_CATEGORIES = Object.freeze([
  ...mk('expense', [['food', '餐饮'], ['transport', '交通'], ['shopping', '购物'],
    ['bills', '账单'], ['fun', '娱乐'], ['other', '其他']]),
  ...mk('income', [['salary', '工资'], ['bonus', '奖金'], ['side', '副业'], ['other_income', '其他收入']]),
]);

export function defaultCategories() {
  return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
}

export function timeValue(iso) {
  const v = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(v) ? -Infinity : v;
}

export function nextUpdatedAt(prev, now) {
  const p = timeValue(prev);
  const n = now.getTime();
  return new Date(p + 1 > n ? p + 1 : n).toISOString();
}

export class ValidationError extends Error {
  constructor(field, message) {
    super(message || `invalid ${field}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const newId = (id, uuid) => (typeof id === 'string' && id !== '' ? id : uuid());

export function buildTransaction(input, existing, { now, uuid }) {
  if (!KINDS.includes(input.kind)) throw new ValidationError('kind');
  const a = input.amountMinor;
  if (!Number.isInteger(a) || a < 1 || a > MAX_MINOR) throw new ValidationError('amount');
  if (!isValidDateString(input.occurredOn)) throw new ValidationError('date');
  if (typeof input.categoryId !== 'string' || input.categoryId.trim() === '') throw new ValidationError('category');
  const note = input.note === undefined || input.note === null ? '' : String(input.note).trim();
  if (note.length > NOTE_MAX) throw new ValidationError('note');
  return {
    id: existing ? existing.id : newId(input.id, uuid),
    kind: input.kind,
    amount_minor: a,
    category_id: input.categoryId,
    occurred_on: input.occurredOn,
    note,
    created_at: existing ? existing.created_at : now.toISOString(),
    updated_at: nextUpdatedAt(existing && existing.updated_at, now),
    deleted: false,
    dirty: 1,
  };
}

export function buildCategory(input, existing, { now, uuid }) {
  const kind = existing ? existing.kind : input.kind;
  if (!KINDS.includes(kind)) throw new ValidationError('kind');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 1 || name.length > CATEGORY_NAME_MAX) throw new ValidationError('name');
  const icon = typeof input.icon === 'string' && input.icon.length >= 1 && input.icon.length <= 30
    ? input.icon
    : (existing ? existing.icon : (kind === 'income' ? 'other_income' : 'other'));
  let sort = input.sort;
  if (sort === undefined && existing) sort = existing.sort;
  if (!Number.isInteger(sort) || sort < 0) throw new TypeError('sort must be a non-negative integer');
  return {
    id: existing ? existing.id : newId(input.id, uuid),
    kind,
    name,
    icon,
    sort,
    updated_at: nextUpdatedAt(existing && existing.updated_at, now),
    deleted: existing ? existing.deleted : false,
    dirty: 1,
  };
}

// ---------- 关键词（3e）：Telegram bot 记账时，文字或店名含关键词就一定记成这个分类 ----------
// 服务器 CHECK：keyword = lower(btrim(keyword)) and char_length(keyword) between 1 and 20（码点数）。
// JS trim() 去的空白比 btrim 多，转小写后的结果 Postgres lower() 不会再变 → 这里通过的，服务器一定收。
export const KEYWORD_MAX = 20;
export const KEYWORD_LIMIT = 200;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g; // trim() 不去、看不见、会让关键词永远对不上

export function normalizeKeyword(raw) {
  // 中间连续的空白（含全形空白、不换行空白）压成一个空格（审核 M-8）；tab、换行不是 Zs，照样算控制字元
  return String(raw ?? '').replace(ZERO_WIDTH, '').replace(/\p{Zs}+/gu, ' ').trim().toLowerCase().trim();
}

/**
 * 检查关键词（先正规化，再以码点算字数）。active：没删除的关键词；selfKeyword：编辑中的那个（新增时 null）。
 * 回 null（可以存）或 'empty' | 'long' | 'bad'（控制字元）| 'dup' | 'limit'。
 */
export function checkKeyword(raw, { active, selfKeyword }) {
  const k = normalizeKeyword(raw);
  if (k === '') return 'empty';
  if ([...k].length > KEYWORD_MAX) return 'long';
  if (/\p{Cc}/u.test(k)) return 'bad';
  if (active.some((r) => r.keyword === k && r.keyword !== selfKeyword)) return 'dup';
  if (selfKeyword == null && active.length >= KEYWORD_LIMIT) return 'limit';
  return null;
}

/** 关键词列：id 就是关键词本身（服务器主键是 (user_id, keyword)）。existing：同一个关键词的旧列（复活已删除的）。 */
export function buildKeyword(input, existing, { now }) {
  const keyword = normalizeKeyword(input.keyword);
  const bad = checkKeyword(keyword, { active: [], selfKeyword: null });
  if (bad) throw new ValidationError('keyword', bad);
  const cat = input.categoryId;
  if (typeof cat !== 'string' || cat.length < 1 || cat.length > 64) throw new ValidationError('category');
  return {
    id: keyword,
    keyword,
    category_id: cat,
    updated_at: nextUpdatedAt(existing && existing.updated_at, now),
    deleted: false,
    dirty: 1,
  };
}

// sync_error（同步标记的坏资料）在用户再改动时清掉，让它重新上传一次
export function markDeleted(rec, now) {
  const { sync_error: _drop, ...rest } = rec;
  return { ...rest, deleted: true, dirty: 1, updated_at: nextUpdatedAt(rec.updated_at, now) };
}

export function markRestored(rec, now) {
  const { sync_error: _drop, ...rest } = rec;
  return { ...rest, deleted: false, dirty: 1, updated_at: nextUpdatedAt(rec.updated_at, now) };
}
