// 检查 AI 认出来的结果（3d）：AI 只给「建议」，金额、分类、日期、备注的最后值都由这里决定。
// 全部是纯函数、不 throw。打包规则：这个档不能 import 别档；顶层名字一律 bot／BOT_ 开头。

export type BotDraft = { kind: 'expense' | 'income'; amountMinor: number; categoryId: string; occurredOn: string; note: string };
type BotExCat = { id: string; kind: 'expense' | 'income' };
type BotExKind = 'expense' | 'income';

const BOT_NOTE_MAX = 500;
const BOT_MERCHANT_MAX = 30;
const BOT_PHOTO_DAYS = 31;
const BOT_AI_KEYS = ['is_payment', 'kind', 'currency', 'amount', 'merchant', 'category_id', 'date'];

// 找不到合适分类时：other／other_income 还在就用；否则该收支第一个；都没有照用 other／other_income（App 显示「未分类」）
export function botFallbackCategory(cats: BotExCat[], kind: BotExKind): string {
  const want = kind === 'income' ? 'other_income' : 'other';
  if (cats.some((c) => c.id === want && c.kind === kind)) return want;
  return cats.find((c) => c.kind === kind)?.id ?? want;
}

// 马来西亚日期（UTC+8，没有夏令时间）。不合格（不是有限数、≤ 0、超过 1e11 秒）回 ''，不 throw。
export function botToday(unixSec: number): string {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec) || unixSec <= 0 || unixSec > 1e11) return '';
  return new Date((unixSec + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

function botAddDays(day: string, n: number): string {
  if (!botValidDay(day)) return '';
  const t = Date.parse(day + 'T00:00:00Z');
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

// 全角数字、全角点、全角逗号换成半角（一个字换一个字，位置不变）
function botHalfWidth(text: string): string {
  return text.replace(/[０-９．，]/g, (ch) => {
    if (ch === '．') return '.';
    if (ch === '，') return ',';
    return String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48);
  });
}

// 千分位开头要 1–9（与 App 的 js/money.js 一致）
const BOT_AMOUNT_TOKEN = /^([1-9]\d{0,2}(,\d{3})+|\d+)(\.\d{1,2})?$/;

// 文字里的金额记号：连续的「数字 . ,」一段，去掉头尾的 . ,；整段合格才算（不拆开）。回传位置与「仙」。
function botNumberTokens(text: string): { start: number; end: number; minor: number }[] {
  const s = botHalfWidth(text);
  const out: { start: number; end: number; minor: number }[] = [];
  for (const m of s.matchAll(/[0-9.,]+/g)) {
    let start = m.index ?? 0;
    let end = start + m[0].length;
    while (start < end && (s[start] === '.' || s[start] === ',')) start++;
    while (end > start && (s[end - 1] === '.' || s[end - 1] === ',')) end--;
    const tok = s.slice(start, end);
    if (!BOT_AMOUNT_TOKEN.test(tok)) continue;
    const [intPart, frac = ''] = tok.replace(/,/g, '').split('.');
    if (intPart.length > 10) continue;
    out.push({ start, end, minor: Number(intPart) * 100 + Number(frac.padEnd(2, '0')) });
  }
  return out;
}

export function botNumbersInText(text: string): number[] {
  return botNumberTokens(text).map((t) => t.minor);
}

export function botTextDate(text: string, today: string): string {
  if (text.includes('前天')) return botAddDays(today, -2);
  if (text.includes('昨天')) return botAddDays(today, -1);
  return today;
}

// 开头的 = + - @ 去掉（防 CSV 公式）
function botCleanNoteStart(s: string): string {
  let r = s.trim();
  while (/^[=+\-@]/.test(r)) r = r.slice(1).trim();
  return r;
}

function botCut(s: string, max: number): string {
  return [...s].slice(0, max).join('').trim();
}

// 按 UTF-16 长度截（App 的 js/model.js 用 note.length 判断 500），不切开表情符号
function botCutUnits(s: string, max: number): string {
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trim();
}

// 文字讯息的备注（总计划 D5、3d M6）：只拿掉被记的那个金额（多个相等时拿最后一个）与紧贴在前面的 rm／RM
// （rm 前面不能是英文字母：farm 5 → farm）；拿掉今天／昨天／前天；去掉控制字元与半个表情符号（Postgres 会拒）
export function botNoteFromText(text: string, amountMinor: number): string {
  let s = text.replace(/\s/g, ' ').replace(/[\p{Cc}\p{Cs}]/gu, '');
  const hit = botNumberTokens(s).filter((t) => t.minor === amountMinor).pop();
  if (hit) {
    let start = hit.start;
    const rm = s.slice(0, start).match(/(^|[^A-Za-z])(rm ?)$/i);
    if (rm) start -= rm[2].length;
    s = s.slice(0, start) + ' ' + s.slice(hit.end);
  }
  s = s.replace(/今天|昨天|前天/g, ' ').replace(/\s+/g, ' ');
  return botCutUnits(botCleanNoteStart(s), BOT_NOTE_MAX);
}

// AI 给的店名（M5）：白名单字元；网址、指令、标签、电话号码都变不成可点的东西；最多 30 码点
export function botCleanMerchant(s: unknown): string {
  if (typeof s !== 'string') return '';
  const r = s
    .replace(/[./:#\\]/g, ' ')
    .replace(/\s/g, ' ')
    .replace(/[^\p{L}\p{M}\p{Nd} &'\-()·]/gu, '')
    .replace(/ +/g, ' ')
    // 电话号码：一段里数字之间只隔着空格、标点（不是文字），累计 7 个以上数字就整段拿掉
    .replace(/\p{Nd}(?:[^\p{L}\p{M}\p{Nd}]*\p{Nd}){6,}/gu, '')
    .replace(/ +/g, ' ');
  return botCut(botCleanNoteStart(r), BOT_MERCHANT_MAX);
}

function botValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export function botCheckExtraction(
  raw: unknown,
  ctx: { source: 'text' | 'photo'; text: string; caption: string; today: string; cats: BotExCat[] },
): { draft: BotDraft } | { fail: 'not_record' | 'foreign' } {
  const no = { fail: 'not_record' as const };
  if (!botValidDay(ctx.today)) return no;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return no;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== BOT_AI_KEYS.length || !BOT_AI_KEYS.every((k) => keys.includes(k))) return no;
  if (typeof r.is_payment !== 'boolean') return no;
  if (r.kind !== 'expense' && r.kind !== 'income') return no;
  for (const k of ['currency', 'amount', 'merchant', 'category_id', 'date']) if (typeof r[k] !== 'string') return no;
  const currency = (r.currency as string).toLowerCase();
  if (!['myr', 'other', 'unknown'].includes(currency)) return no;

  if (r.is_payment === false) return no;
  if (currency === 'other') return { fail: 'foreign' };

  const amount = r.amount as string;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(amount)) return no;
  const [ip, fp = ''] = amount.split('.');
  const amountMinor = Number(ip) * 100 + Number(fp.padEnd(2, '0'));
  if (amountMinor < 1 || amountMinor > 9999999999) return no;
  if (ctx.source === 'text' && !botNumbersInText(ctx.text).includes(amountMinor)) return no;

  const cat = ctx.cats.find((c) => c.id === r.category_id);
  const kind: BotExKind = cat ? cat.kind : (r.kind as BotExKind);
  const categoryId = cat ? cat.id : botFallbackCategory(ctx.cats, kind);

  let occurredOn = ctx.today;
  if (ctx.source === 'text') {
    occurredOn = botTextDate(ctx.text, ctx.today);
  } else {
    const d = r.date as string;
    if (botValidDay(d) && d <= ctx.today && d >= botAddDays(ctx.today, -BOT_PHOTO_DAYS)) occurredOn = d;
  }

  let note: string;
  if (ctx.source === 'text') {
    note = botNoteFromText(ctx.text, amountMinor);
  } else {
    // 有说明文字就用说明文字；清完是空的（例如只写金额或「昨天」）就退回店名
    note = ctx.caption.trim() !== '' ? botNoteFromText(ctx.caption, amountMinor) : '';
    if (note === '') note = botCleanMerchant(r.merchant);
  }

  return { draft: { kind, amountMinor, categoryId, occurredOn, note } };
}
