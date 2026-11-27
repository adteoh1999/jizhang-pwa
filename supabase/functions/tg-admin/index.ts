// 站主设定 Telegram bot（3b-5 第一版；3d 加 webhook、指令、status、pause）。
//   action setup ：setWebhook（排第一：恢复功能优先；带密钥、只收 message 与 callback_query、max_connections 4 限并发、
//                  drop_pending_updates：丢掉积压讯息，暂停期间传的不会在恢复时补记，用户决定 2）、
//                  选单按钮（打开记账 Mini App）、简短介绍、完整介绍、setMyCommands。可以重按（都是「设成这个值」）。
//                  webhook 密钥不合格只挡 setup；status、pause 用不到密钥，照样能用（紧急关闭不能被密钥坏掉卡住）。
//   action status：getWebhookInfo＋24 小时内 AI 次数（不回 Telegram 的错误文字与网址）。
//   action pause ：deleteWebhook（丢掉积压讯息，D5）；再按 setup 就恢复。
// 身份照 invites：邮箱登录（kind = email）且 svc_is_owner。
// Bot API（2026-11-26 核对 https://core.telegram.org/bots/api）：
//   setChatMenuButton     menu_button = MenuButtonWebApp {type:'web_app', text, web_app: WebAppInfo {url}}；不给 chat_id → 改预设按钮
//   setMyShortDescription short_description，0-120 字（不给 language_code → 所有语言）
//   setMyDescription      description，0-512 字
//   setWebhook／deleteWebhook／setMyCommands 成功都回 True；getWebhookInfo 回 WebhookInfo
// 日志只记 method 名＋状态码，绝不记 bot token、邮箱、用户 token。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { getUser, bearer } from '../_shared/user.ts';
import { tgBotTokenOk, tgBotCall, tgBotCallResult, tgSecretOk } from '../_shared/telegram.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowMs?: () => number;
};

const ADMIN_FAIL_MSG = '暂时无法完成，请稍后再试';
// 超时：前端等 25 秒 → 整个流程总时限 18 秒（查身份 2、查站主 2，Bot API 每步最多 5 秒、缩到剩下的时间）。
// 实测（2026-11-26）：第一次连 api.telegram.org 超过 1.5 秒（Telegram 其实已设好），所以不再每步固定 1.5 秒。
const ADMIN_BUDGET_MS = 18000;
const ADMIN_MIN_STEP_MS = 1000;   // 剩不到 1 秒就当时间用完、不送（送了必然逾时）
const ADMIN_USER_MS = 2000;
const ADMIN_RPC_MS = 2000;
const ADMIN_BOT_MS = 5000;
const APP_URL = 'https://jizhang.adteoh.com/';
// 计划 Q4（用户同意）
const MENU_TEXT = '记账';
const SHORT_DESC = '快速记账：点下方「记账」用邮箱登录（第一次需要邀请码）。';
const LONG_DESC = '点下方「记账」按钮，用邮箱验证码登录并连接这个 Telegram，就能在这里记账、看统计，和手机上的记账 App 是同一本账。第一次使用需要邀请码。连接后，也可以直接在这里传付款截图或打「午餐 12.50」记一笔。';
const ADMIN_ACTIONS = ['setup', 'status', 'pause'];
const ADMIN_TG_FAIL = 'Telegram 暂时连不上，请稍后再试';

const logFail = (step: string, detail: string) => console.error(`[tg-admin] ${step}: ${detail}`);

export async function handleTgAdmin(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('Origin'));
  const reply = (status: number, obj: unknown) => json(status, obj, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    return await tgAdminFlow(req, deps, reply);
  } catch {
    logFail('意外错误', '失败');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }
}

async function tgAdminFlow(req: Request, deps: Deps, reply: (status: number, obj: unknown) => Response): Promise<Response> {
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });
  const clock = deps.nowMs ?? (() => Date.now());
  const deadline = clock() + ADMIN_BUDGET_MS;
  const left = () => deadline - clock();

  const token = bearer(req);
  if (!token) return reply(401, { error: '请重新登录后再试' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ADMIN_ACTIONS.includes(input.action)) {
    return reply(400, { error: '看不懂这个请求' });
  }

  let base: string;
  let key: string;
  try {
    base = (deps.env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
    key = secretKey(deps.env);
    if (!base.startsWith('https://')) throw new Error('缺设定');
  } catch {
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }
  const bot = deps.env('TELEGRAM_BOT_TOKEN');
  if (!tgBotTokenOk(bot)) {
    logFail('设定', 'bot token 不合格');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }
  const hookSecret = deps.env('TELEGRAM_WEBHOOK_SECRET');
  if (input.action === 'setup' && !tgSecretOk(hookSecret)) {
    logFail('设定', 'webhook secret 不合格');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }
  const hookUrl = `${base}/functions/v1/telegram-bot`;

  const user = await getUser(deps.fetch, base, key, token, ADMIN_USER_MS);
  if (user === 'gone' || user === 'unauthorized') return reply(401, { error: '请重新登录后再试' });
  if (user === 'error') {
    logFail('查身份', '失败');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }

  let owner = false;
  if (user.kind === 'email') {
    try {
      owner = (await rpc(deps.fetch, base, key, 'svc_is_owner', { p_email: user.email }, ADMIN_RPC_MS)) === true;
    } catch (e) {
      logFail('查站主', e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');
      return reply(500, { error: ADMIN_FAIL_MSG });
    }
  }
  if (!owner) return reply(403, { error: '没有权限' });

  const botMs = () => Math.max(1, Math.min(ADMIN_BOT_MS, left()));

  if (input.action === 'status') {
    if (left() < ADMIN_MIN_STEP_MS) return reply(502, { error: ADMIN_TG_FAIL });
    const r = await tgBotCallResult(deps.fetch, bot, 'getWebhookInfo', {}, botMs());
    if (!r.ok) {
      logFail('getWebhookInfo', `HTTP ${r.status}`);
      return reply(502, { error: ADMIN_TG_FAIL });
    }
    const info = (r.result && typeof r.result === 'object') ? r.result as Record<string, unknown> : {};
    const url = typeof info.url === 'string' ? info.url : '';
    const pc = info.pending_update_count;
    const pending = Number.isSafeInteger(pc) && (pc as number) >= 0 ? pc as number : 0;
    const errSec = info.last_error_date;
    const lastErrorAt = Number.isSafeInteger(errSec) && (errSec as number) > 0 && (errSec as number) <= 1e11
      ? new Date((errSec as number) * 1000).toISOString() : null;
    let aiUsed24h: number | null = null;
    try {
      const n = await rpc(deps.fetch, base, key, 'svc_bot_ai_count', {}, Math.max(1, Math.min(ADMIN_RPC_MS, left())));
      aiUsed24h = Number.isSafeInteger(n) && (n as number) >= 0 ? n as number : null;
    } catch (e) {
      logFail('AI 次数', e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');
    }
    return reply(200, { ok: true, webhook: url === hookUrl ? 'ok' : url ? 'wrong_url' : 'none', pending, lastErrorAt, aiUsed24h });
  }

  const steps: [string, unknown][] = input.action === 'pause'
    ? [['deleteWebhook', { drop_pending_updates: true }]]
    : [
      ['setWebhook', { url: hookUrl, secret_token: hookSecret, allowed_updates: ['message', 'callback_query'], max_connections: 4,
        drop_pending_updates: true }],
      ['setChatMenuButton', { menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: APP_URL } } }],
      ['setMyShortDescription', { short_description: SHORT_DESC }],
      ['setMyDescription', { description: LONG_DESC }],
      ['setMyCommands', { commands: [{ command: 'start', description: '开始／说明' }, { command: 'help', description: '怎么记账' }] }],
    ];
  for (const [method, payload] of steps) {
    if (left() < ADMIN_MIN_STEP_MS) {
      logFail(method, '超过总时限，没送');
      return reply(502, { error: ADMIN_TG_FAIL });
    }
    const r = await tgBotCall(deps.fetch, bot, method, payload, botMs());
    if (!r.ok) {
      logFail(method, `HTTP ${r.status}`);
      return reply(502, { error: ADMIN_TG_FAIL });
    }
  }
  return reply(200, { ok: true });
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleTgAdmin(req, realDeps()));
