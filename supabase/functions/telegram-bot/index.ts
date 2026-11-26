// Telegram bot webhook（3d）：已连接、同意过 AI 说明的人，传付款截图或文字 → AI 认出栏位 → 程式检查 → 记一笔。
// 只认 Telegram 送来的密钥 header（X-Telegram-Bot-Api-Secret-Token，固定时间比较）。部署要 --no-verify-jwt。
// 规则（3d 计划 r2）：
//   - AI 的文字不直接回给用户：回复全由 bot-reply.ts 的固定句子组成；店名已在 bot-extract 清理。
//   - 「今天」= Telegram 讯息时间（马来西亚日期），不用执行时间。
//   - 回应码：处理完或永久无法处理 → 200；只有数据库暂时失败（claim、record）或「已记账但回复没送出」→ 5xx 让 Telegram 重送。
//   - 截图只在记忆体；送给 Anthropic 的只有说明、今天日期、分类清单、文字或截图。
//   - 日志只记「步骤＋状态码／错误种类」，绝不记讯息文字、截图、AI 回应、file_path、网址、telegram_id。
// 打包规则：这个档自己的顶层名字一律 tb／TB_ 开头（BOT_ 是 bot-reply.ts 的）。
import { secretKey, rpc } from '../_shared/http.ts';
import { tgBotTokenOk, tgBotCallResult, tgSecretOk, tgSecretEqual, tgPickPhoto, tgImageDoc, tgDownload, tgSniffImage, tgBase64 } from '../_shared/telegram.ts';
import { botMergeCategories } from '../_shared/bot-categories.ts';
import { botToday, botCheckExtraction } from '../_shared/bot-extract.ts';
import { aiKeyOk, aiBuildRequest, aiExtract } from '../_shared/ai-extract.ts';
import { BOT_NOT_UNDERSTOOD, BOT_FOREIGN, BOT_QUOTA, BOT_DOWN, BOT_IMAGE_BAD, BOT_UNLINKED_START, BOT_HELP, BOT_CONSENT, BOT_CONSENT_OK, BOT_SKIPPED, BOT_ANS_EXPIRED, BOT_ANS_DELETED, BOT_ANS_CAT_CHANGED, BOT_ANS_UNDONE, BOT_ANS_RECORDED, botAnsCategory, botRecordedText, botUndoneText, botSimilarText, botBigText, botCategoryPrompt, botRecordedKeyboard, botAskKeyboard, botConsentKeyboard, botUnlinkedKeyboard, botCategoryKeyboard, botCatHash, botParseCallback } from '../_shared/bot-reply.ts';

type TbDeps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowMs?: () => number;
  aiMs?: number;              // AI 逾时（测试可缩短）
};

const TB_AI_USER_MAX = 30;
const TB_AI_SITE_MAX = 200;
const TB_TEXT_MAX = 500;
const TB_IMAGE_MAX = 5 * 1024 * 1024;
const TB_BIG_MINOR = 100000;          // 截图 ≥ RM 1,000 先问（D2）
const TB_BUDGET_MS = 35000;
const TB_RPC_MS = 2000;
const TB_RPC_WRITE_MS = 4000;
const TB_TYPING_MS = 1500;
const TB_SEND_MS = 5000;
const TB_DOWNLOAD_MS = 8000;
const TB_AI_MS = 20000;
const TB_AI_MIN_LEFT_MS = 3000;       // 剩下的时间不够叫 AI 就不叫

const tbLog = (step: string, detail: string) => console.error(`[telegram-bot] ${step}: ${detail}`);
// rpc 抛的讯息是自己写的固定文字（函数名＋状态码），可以记；其他错误一律只记「失败」
const tbErr = (e: unknown) => (e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');
const tbStatus = (status: number) => new Response(null, { status });

type TbCtx = {
  deps: TbDeps;
  base: string;
  key: string;
  bot: string;
  left: () => number;
  chatId: number;
  messageId: number;
  updateId: number;
  today: string;
};

type TbTx = { id: string; kind: string; amount_minor: number; category_id: string; occurred_on: string; note: string; deleted?: boolean };
type TbOutcome =
  | { status: 'recorded'; tx: TbTx | null }
  | { status: 'asked'; reason: 'similar' | 'big'; pending: TbTx; similar: TbTx | null }
  | { status: 'gone' };

export async function handleTelegramBot(req: Request, deps: TbDeps): Promise<Response> {
  try {
    return await tbFlow(req, deps);
  } catch {
    tbLog('意外错误', '失败');
    return tbStatus(500);
  }
}

async function tbFlow(req: Request, deps: TbDeps): Promise<Response> {
  if (req.method !== 'POST') return tbStatus(405);
  const secret = deps.env('TELEGRAM_WEBHOOK_SECRET');
  if (!tgSecretOk(secret)) {
    tbLog('设定', 'webhook secret 不合格');
    return tbStatus(500);
  }
  if (!(await tgSecretEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), secret))) return tbStatus(401);

  const bot = deps.env('TELEGRAM_BOT_TOKEN');
  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    tbLog('设定', '缺 SUPABASE_URL 或 secret key');
    return tbStatus(500);
  }
  if (!tgBotTokenOk(bot)) {
    tbLog('设定', 'bot token 不合格');
    return tbStatus(500);
  }

  let upd: any;
  try { upd = await req.json(); } catch { return tbStatus(200); }
  if (!upd || typeof upd !== 'object' || !Number.isSafeInteger(upd.update_id) || upd.update_id <= 0) return tbStatus(200);

  const clock = deps.nowMs ?? (() => Date.now());
  const deadline = clock() + TB_BUDGET_MS;
  const left = () => deadline - clock();

  if (upd.callback_query) return await tbCallback(deps, base, key, bot as string, left, upd.update_id, upd.callback_query, clock);

  const msg = upd.message;
  if (!msg || typeof msg !== 'object') return tbStatus(200);
  const from = msg.from;
  const chat = msg.chat;
  if (!from || !chat || from.is_bot === true || chat.type !== 'private') return tbStatus(200);
  if (!Number.isSafeInteger(from.id) || from.id <= 0 || chat.id !== from.id) return tbStatus(200);
  if (!Number.isSafeInteger(msg.date) || msg.date <= 0 || !Number.isSafeInteger(msg.message_id)) return tbStatus(200);

  const ctx: TbCtx = {
    deps, base, key, bot: bot as string, left, chatId: from.id, messageId: msg.message_id, updateId: upd.update_id,
    today: botToday(msg.date),
  };
  return await tbMessage(ctx, msg);
}

const tbMs = (ctx: TbCtx, ms: number) => Math.max(1, Math.min(ms, ctx.left()));

async function tbRpc(ctx: TbCtx, name: string, args: unknown, ms = TB_RPC_MS): Promise<any> {
  return await rpc(ctx.deps.fetch, ctx.base, ctx.key, name, args, tbMs(ctx, ms));
}

// 回一则讯息到这个私聊（纯文字、关预览、引用原讯息）；回传有没有送成
async function tbSend(ctx: TbCtx, text: string, markup?: unknown): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: ctx.chatId, text,
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: ctx.messageId, allow_sending_without_reply: true },
  };
  if (markup) payload.reply_markup = markup;
  const r = await tgBotCallResult(ctx.deps.fetch, ctx.bot, 'sendMessage', payload, tbMs(ctx, TB_SEND_MS));
  if (!r.ok) tbLog('sendMessage', `HTTP ${r.status}`);
  return r.ok;
}

async function tbTyping(ctx: TbCtx): Promise<void> {
  await tgBotCallResult(ctx.deps.fetch, ctx.bot, 'sendChatAction', { chat_id: ctx.chatId, action: 'typing' }, tbMs(ctx, TB_TYPING_MS));
}

async function tbFinish(ctx: TbCtx): Promise<void> {
  try {
    await tbRpc(ctx, 'svc_bot_finish', { p_update_id: ctx.updateId, p_telegram_id: ctx.chatId });
  } catch (e) {
    tbLog('finish', tbErr(e));
  }
}

async function tbReplied(ctx: TbCtx): Promise<void> {
  try {
    await tbRpc(ctx, 'svc_bot_replied', { p_update_id: ctx.updateId, p_telegram_id: ctx.chatId });
  } catch (e) {
    tbLog('replied', tbErr(e));
  }
}

async function tbRefund(ctx: TbCtx, useId: unknown): Promise<void> {
  if (!Number.isSafeInteger(useId)) return;
  try {
    await tbRpc(ctx, 'svc_bot_ai_refund', { p_telegram_id: ctx.chatId, p_use_id: useId });
  } catch (e) {
    tbLog('refund', tbErr(e));
  }
}

// 没记账的结尾：回一句（送不成也照样 200，不让 Telegram 重送）＋ finish
async function tbEnd(ctx: TbCtx, text: string, markup?: unknown): Promise<Response> {
  await tbSend(ctx, text, markup);
  await tbFinish(ctx);
  return tbStatus(200);
}

const tbIsCommand = (text: string, cmd: string) => new RegExp(`^/${cmd}(@\\w+)?(\\s|$)`).test(text);

async function tbCategories(ctx: TbCtx): Promise<ReturnType<typeof botMergeCategories> | null> {
  const server = await tbRpc(ctx, 'svc_bot_categories', { p_telegram_id: ctx.chatId });
  return server === null ? null : botMergeCategories(server);
}

const tbCatName = (cats: { id: string; name: string }[], id: string) => cats.find((c) => c.id === id)?.name ?? '未分类';

// record／claim 补发共用：把结果组成回复
function tbRender(ctx: TbCtx, out: TbOutcome, cats: { id: string; name: string }[]): { text: string; markup: unknown } | null {
  if (out.status === 'recorded') {
    const tx = out.tx;
    if (!tx || tx.deleted) return null;
    return {
      text: botRecordedText({ amountMinor: tx.amount_minor, categoryName: tbCatName(cats, tx.category_id), note: tx.note,
        occurredOn: tx.occurred_on, today: ctx.today }),
      markup: botRecordedKeyboard(tx.id),
    };
  }
  if (out.status === 'asked') {
    const text = out.reason === 'big'
      ? botBigText(out.pending, tbCatName(cats, out.pending.category_id))
      : botSimilarText(out.similar, out.similar ? tbCatName(cats, out.similar.category_id) : '', ctx.today);
    return { text, markup: botAskKeyboard(out.pending.id, out.reason) };
  }
  return null;
}

// 送出记账／问句的回复：成功 → replied、200；失败 → 500（重送时 claim 回 resend 补发）
async function tbDeliver(ctx: TbCtx, out: TbOutcome, cats: { id: string; name: string }[]): Promise<Response> {
  const r = tbRender(ctx, out, cats);
  if (!r) {
    await tbReplied(ctx);
    return tbStatus(200);
  }
  if (!(await tbSend(ctx, r.text, r.markup))) return tbStatus(500);
  await tbReplied(ctx);
  return tbStatus(200);
}

async function tbMessage(ctx: TbCtx, msg: any): Promise<Response> {
  const text = typeof msg.text === 'string' ? msg.text.trim() : null;

  // ---- 领取（去重）----
  let claim: any;
  try {
    claim = await tbRpc(ctx, 'svc_bot_claim', { p_update_id: ctx.updateId, p_telegram_id: ctx.chatId }, TB_RPC_WRITE_MS);
  } catch (e) {
    tbLog('claim', tbErr(e));
    return tbStatus(503);
  }
  const what = claim?.do;
  if (what === 'unlinked') {
    if (text !== null && tbIsCommand(text, 'start')) await tbSend(ctx, BOT_UNLINKED_START, botUnlinkedKeyboard());
    return tbStatus(200);
  }
  if (what === 'resend') {
    let cats: { id: string; name: string }[];
    try {
      cats = (await tbCategories(ctx)) ?? [];
    } catch (e) {
      tbLog('categories', tbErr(e));
      return tbStatus(503);
    }
    return await tbDeliver(ctx, claim as TbOutcome, cats);
  }
  if (what !== 'go') return tbStatus(200);   // busy、dup：别的执行在处理或已处理过（D1）

  // ---- 指令 ----
  if (text !== null && (tbIsCommand(text, 'start') || tbIsCommand(text, 'help'))) return await tbEnd(ctx, BOT_HELP);

  // ---- 分辨内容 ----
  let source: 'text' | 'photo';
  let fileId = '';
  const caption = typeof msg.caption === 'string' ? msg.caption.trim() : '';
  if (text !== null) {
    if (text === '' || [...text].length > TB_TEXT_MAX || !/[0-9０-９]/.test(text)) return await tbEnd(ctx, BOT_NOT_UNDERSTOOD);
    source = 'text';
  } else if (Array.isArray(msg.photo)) {
    const p = tgPickPhoto(msg.photo);
    if (!p) return await tbEnd(ctx, BOT_IMAGE_BAD);
    source = 'photo';
    fileId = p.fileId;
  } else if (msg.document && typeof msg.document === 'object') {
    const mime = msg.document.mime_type;
    const d = tgImageDoc(msg.document);
    if (!d) return await tbEnd(ctx, typeof mime === 'string' && mime.startsWith('image/') ? BOT_IMAGE_BAD : BOT_NOT_UNDERSTOOD);
    source = 'photo';
    fileId = d.fileId;
  } else {
    return await tbEnd(ctx, BOT_NOT_UNDERSTOOD);
  }

  const aiKey = ctx.deps.env('ANTHROPIC_API_KEY');
  if (!aiKeyOk(aiKey)) {
    tbLog('设定', 'ai_key');
    return await tbEnd(ctx, BOT_DOWN);
  }

  // ---- 第一次用 AI 先同意（D4）----
  if (claim.ai_ok !== true) return await tbEnd(ctx, BOT_CONSENT, botConsentKeyboard());

  // ---- 截图：下载、认格式（还没扣次数）----
  let image: { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string } | undefined;
  await tbTyping(ctx);
  if (source === 'photo') {
    const bytes = await tgDownload(ctx.deps.fetch, ctx.bot, fileId, TB_IMAGE_MAX, tbMs(ctx, TB_DOWNLOAD_MS));
    const mediaType = bytes ? tgSniffImage(bytes) : null;
    if (!bytes || !mediaType) {
      tbLog('下载截图', bytes ? '不是图片' : '失败');
      return await tbEnd(ctx, BOT_IMAGE_BAD);
    }
    image = { mediaType, base64: tgBase64(bytes) };
  }

  // ---- 扣次数 ----
  let reserve: any;
  try {
    reserve = await tbRpc(ctx, 'svc_bot_ai_reserve',
      { p_telegram_id: ctx.chatId, p_user_max: TB_AI_USER_MAX, p_site_max: TB_AI_SITE_MAX }, TB_RPC_WRITE_MS);
  } catch (e) {
    tbLog('ai_reserve', tbErr(e));
    return await tbEnd(ctx, BOT_DOWN);
  }
  if (reserve?.ok !== true) {
    if (reserve?.why === 'gone') {
      await tbFinish(ctx);
      return tbStatus(200);
    }
    if (reserve?.why === 'site') tbLog('ai_reserve', 'site');
    return await tbEnd(ctx, BOT_QUOTA);
  }
  const useId = reserve.use_id;

  // ---- 叫 AI ----
  let cats: ReturnType<typeof botMergeCategories> | null;
  try {
    cats = await tbCategories(ctx);
  } catch (e) {
    tbLog('categories', tbErr(e));
    await tbRefund(ctx, useId);
    return await tbEnd(ctx, BOT_DOWN);
  }
  if (cats === null) {
    await tbRefund(ctx, useId);
    await tbFinish(ctx);
    return tbStatus(200);
  }
  if (ctx.left() < TB_AI_MIN_LEFT_MS) {
    tbLog('AI', '时间不够');
    await tbRefund(ctx, useId);
    return await tbEnd(ctx, BOT_DOWN);
  }
  const body = aiBuildRequest(source === 'text'
    ? { today: ctx.today, cats, text: text as string }
    : { today: ctx.today, cats, caption, image });
  const aiMs = Math.min(ctx.deps.aiMs ?? TB_AI_MS, ctx.left() - 2000);
  const ai = await aiExtract(ctx.deps.fetch, aiKey, body, Math.max(1, aiMs));
  if (!ai.ok) {
    if (ai.why === 'http') {
      tbLog('AI', `HTTP ${ai.status}${ai.errType ? ' ' + ai.errType : ''}`);
      await tbRefund(ctx, useId);
      return await tbEnd(ctx, source === 'photo' && ai.errType === 'invalid_request_error' ? BOT_IMAGE_BAD : BOT_DOWN);
    }
    tbLog('AI', ai.why);
    return await tbEnd(ctx, ai.why === 'timeout' ? BOT_DOWN : BOT_NOT_UNDERSTOOD);
  }

  // ---- 程式检查 ----
  const check = botCheckExtraction(ai.data, { source, text: text ?? '', caption, today: ctx.today, cats });
  if ('fail' in check) return await tbEnd(ctx, check.fail === 'foreign' ? BOT_FOREIGN : BOT_NOT_UNDERSTOOD);
  const d = check.draft;

  // ---- 记账 ----
  let out: TbOutcome;
  try {
    out = await tbRpc(ctx, 'svc_bot_record', {
      p_update_id: ctx.updateId, p_telegram_id: ctx.chatId, p_kind: d.kind, p_amount_minor: d.amountMinor,
      p_category_id: d.categoryId, p_occurred_on: d.occurredOn, p_note: d.note,
      p_ask_big: source === 'photo' && d.amountMinor >= TB_BIG_MINOR,
    }, TB_RPC_WRITE_MS);
  } catch (e) {
    tbLog('record', tbErr(e));
    return tbStatus(503);
  }
  if (!out || out.status === 'gone') return tbStatus(200);
  return await tbDeliver(ctx, out, cats);
}

// ======================= 按钮流程 =======================
// 每条路都正好 answerCallbackQuery 一次（不然对方画面一直转圈）；按钮资料当不可信输入（botParseCallback 严格格式）。
// 按钮所在讯息太旧或被删时，Telegram 给 InaccessibleMessage（date 一律 0，但 chat、message_id 还在）：照样处理，
// 编辑讯息失败就改用短字说明（账已经改好了）。rpc 失败 → 回「现在记不了」、200（按钮不会重送，用户再按就好）。
async function tbCallback(
  deps: TbDeps, base: string, key: string, bot: string, left: () => number, updateId: number, cq: any, clock: () => number,
): Promise<Response> {
  if (!cq || typeof cq !== 'object' || typeof cq.id !== 'string' || cq.id === '') return tbStatus(200);
  const answer = async (text: string) => {
    const r = await tgBotCallResult(deps.fetch, bot, 'answerCallbackQuery',
      text ? { callback_query_id: cq.id, text } : { callback_query_id: cq.id }, Math.max(1, Math.min(TB_SEND_MS, left())));
    if (!r.ok) tbLog('answerCallbackQuery', `HTTP ${r.status}`);
  };
  const from = cq.from;
  const m = cq.message;
  if (!from || from.is_bot === true || !Number.isSafeInteger(from.id) || from.id <= 0
      || !m || !m.chat || m.chat.type !== 'private' || m.chat.id !== from.id || !Number.isSafeInteger(m.message_id)) {
    await answer(BOT_ANS_EXPIRED);
    return tbStatus(200);
  }
  const ctx: TbCtx = {
    deps, base, key, bot, left, chatId: from.id, messageId: m.message_id, updateId,
    today: botToday(Math.floor(clock() / 1000)),
  };
  let text: string;
  try {
    text = await tbCallbackOp(ctx, botParseCallback(cq.data));
  } catch (e) {
    tbLog('按钮', tbErr(e));
    text = BOT_DOWN;
  }
  await answer(text);
  return tbStatus(200);
}

async function tbEditText(ctx: TbCtx, text: string, markup?: unknown): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: ctx.chatId, message_id: ctx.messageId, text, link_preview_options: { is_disabled: true },
  };
  if (markup) payload.reply_markup = markup;
  const r = await tgBotCallResult(ctx.deps.fetch, ctx.bot, 'editMessageText', payload, tbMs(ctx, TB_SEND_MS));
  if (!r.ok) tbLog('editMessageText', `HTTP ${r.status}`);
  return r.ok;
}

async function tbEditMarkup(ctx: TbCtx, markup: unknown): Promise<boolean> {
  const r = await tgBotCallResult(ctx.deps.fetch, ctx.bot, 'editMessageReplyMarkup',
    { chat_id: ctx.chatId, message_id: ctx.messageId, reply_markup: markup }, tbMs(ctx, TB_SEND_MS));
  if (!r.ok) tbLog('editMessageReplyMarkup', `HTTP ${r.status}`);
  return r.ok;
}

const tbLineOf = (ctx: TbCtx, tx: TbTx, cats: { id: string; name: string }[]) => ({
  amountMinor: tx.amount_minor, categoryName: tbCatName(cats, tx.category_id), note: tx.note, occurredOn: tx.occurred_on, today: ctx.today,
});

// 回传要 answer 的短字（'' ＝ 不显示）
async function tbCallbackOp(ctx: TbCtx, cb: ReturnType<typeof botParseCallback>): Promise<string> {
  if (!cb) return BOT_ANS_EXPIRED;
  const tg = ctx.chatId;

  if (cb.op === 'a') {
    const ok = await tbRpc(ctx, 'svc_bot_ai_consent', { p_telegram_id: tg }, TB_RPC_WRITE_MS);
    if (ok !== true) return BOT_ANS_EXPIRED;
    return (await tbEditText(ctx, BOT_CONSENT_OK)) ? '' : BOT_CONSENT_OK;
  }

  if (cb.op === 'u') {
    const r = await tbRpc(ctx, 'svc_bot_undo', { p_telegram_id: tg, p_tx_id: cb.id }, TB_RPC_WRITE_MS);
    if (r?.status === 'already') return BOT_ANS_DELETED;
    if (r?.status === 'busy') return BOT_DOWN;
    if (r?.status !== 'done' || !r.tx) return BOT_ANS_EXPIRED;
    const cats = (await tbCategories(ctx)) ?? [];
    return (await tbEditText(ctx, botUndoneText(tbLineOf(ctx, r.tx, cats)))) ? '' : BOT_ANS_UNDONE;
  }

  if (cb.op === 'c' || cb.op === 'b') {
    const tx = await tbRpc(ctx, 'svc_bot_tx', { p_telegram_id: tg, p_tx_id: cb.id });
    if (!tx) return BOT_ANS_EXPIRED;
    if (tx.deleted) return BOT_ANS_DELETED;
    if (cb.op === 'b') {
      await tbEditMarkup(ctx, botRecordedKeyboard(cb.id));
      return '';
    }
    const cats = await tbCategories(ctx);
    if (!cats) return BOT_ANS_EXPIRED;
    const { markup, truncated } = await botCategoryKeyboard(cb.id, cats);
    await tbEditMarkup(ctx, markup);
    return botCategoryPrompt(truncated);
  }

  if (cb.op === 's') {
    const cats = await tbCategories(ctx);
    if (!cats) return BOT_ANS_EXPIRED;
    const cat = cb.idx < Math.min(cats.length, 30) ? cats[cb.idx] : null;
    if (!cat || (await botCatHash(cat.id)) !== cb.h) return BOT_ANS_CAT_CHANGED;
    const r = await tbRpc(ctx, 'svc_bot_set_category',
      { p_telegram_id: tg, p_tx_id: cb.id, p_category_id: cat.id, p_kind: cat.kind }, TB_RPC_WRITE_MS);
    if (r?.status === 'deleted') return BOT_ANS_DELETED;
    if (r?.status === 'busy') return BOT_DOWN;
    if (r?.status !== 'done' || !r.tx) return BOT_ANS_EXPIRED;
    const ok = await tbEditText(ctx, botRecordedText(tbLineOf(ctx, r.tx, cats)), botRecordedKeyboard(cb.id));
    return ok ? '' : botAnsCategory(cat.name);
  }

  if (cb.op === 'y') {
    const r = await tbRpc(ctx, 'svc_bot_confirm', { p_telegram_id: tg, p_pending_id: cb.id }, TB_RPC_WRITE_MS);
    if (r?.status !== 'recorded' || !r.tx) return BOT_ANS_EXPIRED;
    if (r.tx.deleted) return BOT_ANS_DELETED;
    const cats = (await tbCategories(ctx)) ?? [];
    const ok = await tbEditText(ctx, botRecordedText(tbLineOf(ctx, r.tx, cats)), botRecordedKeyboard(r.tx.id));
    return ok ? '' : BOT_ANS_RECORDED;
  }

  // cb.op === 'n'
  const gone = (await tbRpc(ctx, 'svc_bot_discard', { p_telegram_id: tg, p_pending_id: cb.id }, TB_RPC_WRITE_MS)) !== true;
  if (gone) return BOT_ANS_EXPIRED;
  return (await tbEditText(ctx, BOT_SKIPPED)) ? '' : BOT_SKIPPED;
}

function tbRealDeps(): TbDeps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleTelegramBot(req, tbRealDeps()));
