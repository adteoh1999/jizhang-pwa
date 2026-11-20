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

export function markDeleted(rec, now) {
  return { ...rec, deleted: true, dirty: 1, updated_at: nextUpdatedAt(rec.updated_at, now) };
}

export function markRestored(rec, now) {
  return { ...rec, deleted: false, dirty: 1, updated_at: nextUpdatedAt(rec.updated_at, now) };
}
