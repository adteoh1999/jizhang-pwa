// bot 回给用户的全部文字与按钮（3d）。只有这里会组出回复；AI 的文字不会直接进来（店名已在 bot-extract 清理过）。
// 文案用户 2026-11-26 深夜同意（3d 计划文末「用户的决定」），测试逐字锁住，要改先问用户。
// 2026-11-27 用户同意：隐私说明补上「你的分类名称」（AI 要从分类清单里选，清单也会送出）。
// 打包规则：这个档不能 import 别档；顶层名字一律 bot／BOT_ 开头。

export const BOT_NOT_UNDERSTOOD = '没看懂这笔帐，请传付款截图，或打像『午餐 12.50』这样的文字';
export const BOT_FOREIGN = '目前只支援 RM，这笔请手动记';
export const BOT_QUOTA = 'AI 记账次数用完了（每人 24 小时内 30 次），请晚点再试，或打开 App 手动记。';
export const BOT_DOWN = '现在记不了，请稍后再试，或打开 App 手动记。';
export const BOT_IMAGE_BAD = '这张图片读不了，请传截图（JPG／PNG，5 MB 以内）。';
export const BOT_UNLINKED_START = '请先点下方按钮打开记账、用邮箱登录。';
export const BOT_SKIPPED = '好，这笔不记。';
const BOT_PRIVACY = '截图、文字和你的分类名称会送到 Anthropic 的 AI（Claude）认出金额和分类，不会被拿去训练；Anthropic 一般最多保存 30 天（被安全系统标记的可能更久）。我们这里不存截图；截图会留在你和 bot 的聊天记录里，可以自己删。';
export const BOT_HELP = '传付款截图，或打像「午餐 12.50」「昨天 晚餐 15」「工资 3000」这样的文字，就会自动记一笔。记错了按［改分类］或［撤销］；改讯息不会改账，请按［改分类］或到 App 改。没有回应就再传一次。\n'
  + `说明：${BOT_PRIVACY}目前只支援 RM。`;
export const BOT_CONSENT = `第一次使用 AI 记账前请先看：${BOT_PRIVACY}\n同意后，请再传一次这笔。`;
export const BOT_CONSENT_OK = '✅ 已同意。现在可以传付款截图，或打「午餐 12.50」记账了。';

// 按按钮后的短字（answerCallbackQuery，0–200 字）
export const BOT_ANS_EXPIRED = '这个按钮已经过期了。';
export const BOT_ANS_DELETED = '这笔已经删除了。';
export const BOT_ANS_CAT_CHANGED = '分类有变动，请重新按［改分类］。';
export const BOT_ANS_UNDONE = '已撤销';
export const BOT_ANS_RECORDED = '已记好';
export const botAnsCategory = (name: string) => `已改成 ${name}`;

const BOT_APP_URL = 'https://jizhang.adteoh.com/';
const BOT_NOTE_SHOW = 30;
const BOT_CAT_MAX = 30;

// 与 App 的 js/money.js formatRM 相同（测试比对）
export function botFormatRM(minor: number): string {
  const abs = Math.abs(Math.trunc(minor));
  const i = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0 ? '−' : ''}RM ${i}.${String(abs % 100).padStart(2, '0')}`;
}

function botMonthDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function botNotePart(note: string): string {
  if (!note) return '';
  const cp = [...note];
  return `（${cp.length > BOT_NOTE_SHOW ? cp.slice(0, BOT_NOTE_SHOW).join('') + '…' : note}）`;
}

type BotLine = { amountMinor: number; categoryName: string; note: string; occurredOn: string; today: string };

function botLine(d: BotLine): string {
  return `${d.categoryName} ${botFormatRM(d.amountMinor)}${botNotePart(d.note)}${d.occurredOn !== d.today ? ` · ${botMonthDay(d.occurredOn)}` : ''}`;
}

export function botRecordedText(d: BotLine & { kind?: string }): string {
  return `✅ 已记：${botLine(d)}`;
}

export function botUndoneText(d: BotLine): string {
  return `↩️ 已撤销：${botLine(d)}`;
}

export function botSimilarText(
  similar: { amount_minor: number; note: string; occurred_on: string } | null | undefined, catName: string, today: string,
): string {
  if (!similar) return '已经有一笔差不多的账。还要记这一笔吗？';
  const when = similar.occurred_on === today ? '今天' : botMonthDay(similar.occurred_on);
  return `${when}已经有一笔差不多的：${catName} ${botFormatRM(similar.amount_minor)}${botNotePart(similar.note)}。还要记这一笔吗？`;
}

// 不是今天的账就带日期（用户决定 6，2026-11-27）
export function botBigText(pending: { amount_minor: number; occurred_on: string }, catName: string, today: string): string {
  const day = pending.occurred_on !== today ? ` · ${botMonthDay(pending.occurred_on)}` : '';
  return `截图上的金额是 ${botFormatRM(pending.amount_minor)}（${catName}${day}），要记吗？`;
}

export function botCategoryPrompt(truncated: boolean): string {
  return truncated ? '要改成哪个分类？（其余分类请到 App 改）' : '要改成哪个分类？';
}

// ---------- 按钮 ----------
type BotButton = { text: string; callback_data: string } | { text: string; web_app: { url: string } };
export type BotMarkup = { inline_keyboard: BotButton[][] };

export function botRecordedKeyboard(tx: string): BotMarkup {
  return { inline_keyboard: [[{ text: '改分类', callback_data: `c:${tx}` }, { text: '撤销', callback_data: `u:${tx}` }]] };
}

export function botAskKeyboard(pending: string, reason: 'similar' | 'big'): BotMarkup {
  return { inline_keyboard: [[
    { text: reason === 'big' ? '要记' : '还要记', callback_data: `y:${pending}` }, { text: '不用', callback_data: `n:${pending}` }]] };
}

export function botConsentKeyboard(): BotMarkup {
  return { inline_keyboard: [[{ text: '同意并开始', callback_data: 'a:1' }]] };
}

export function botUnlinkedKeyboard(): BotMarkup {
  return { inline_keyboard: [[{ text: '记账', web_app: { url: BOT_APP_URL } }]] };
}

// 分类 id 的 SHA-256 前 8 位 hex：选分类的按钮带它，按下时核对清单有没有变（分类 id 最长 64 字，放不进 64 bytes）
export async function botCatHash(id: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  return [...h.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 分类选单：按清单顺序（支出在前）、每排 3 个、最多 30 个、最后［取消］
export async function botCategoryKeyboard(tx: string, cats: { id: string; name: string }[]): Promise<{ markup: BotMarkup; truncated: boolean }> {
  const shown = cats.slice(0, BOT_CAT_MAX);
  const buttons = await Promise.all(shown.map(async (c, i) => ({ text: c.name, callback_data: `s:${tx}:${i}:${await botCatHash(c.id)}` })));
  const rows: BotButton[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([{ text: '取消', callback_data: `b:${tx}` }]);
  return { markup: { inline_keyboard: rows }, truncated: cats.length > BOT_CAT_MAX };
}

const BOT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BOT_CB_ID = new RegExp(`^([ucbyn]):(${BOT_UUID})$`);
const BOT_CB_SEL = new RegExp(`^s:(${BOT_UUID}):(0|[1-9]\\d?):([0-9a-f]{8})$`);

export type BotCallback =
  | { op: 'u' | 'c' | 'b' | 'y' | 'n'; id: string }
  | { op: 's'; id: string; idx: number; h: string }
  | { op: 'a' };

// 按钮资料当不可信输入：格式严格，不合格一律 null
export function botParseCallback(data: unknown): BotCallback | null {
  if (typeof data !== 'string' || data === '' || new TextEncoder().encode(data).length > 64) return null;
  if (data === 'a:1') return { op: 'a' };
  let m = data.match(BOT_CB_ID);
  if (m) return { op: m[1] as 'u' | 'c' | 'b' | 'y' | 'n', id: m[2] };
  m = data.match(BOT_CB_SEL);
  if (m) {
    const idx = Number(m[2]);
    return idx < BOT_CAT_MAX ? { op: 's', id: m[1], idx, h: m[3] } : null;
  }
  return null;
}
