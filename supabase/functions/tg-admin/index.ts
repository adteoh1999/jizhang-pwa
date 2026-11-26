// 站主设定 Telegram bot（3b-5 第一版）：选单按钮（打开记账 Mini App）、简短介绍、完整介绍。
// 身份照 invites：邮箱登录（kind = email）且 svc_is_owner。可以重按（三个 method 都是「设成这个值」）。
// Bot API（2026-11-26 核对 https://core.telegram.org/bots/api）：
//   setChatMenuButton     menu_button = MenuButtonWebApp {type:'web_app', text, web_app: WebAppInfo {url}}；不给 chat_id → 改预设按钮
//   setMyShortDescription short_description，0-120 字（不给 language_code → 所有语言）
//   setMyDescription      description，0-512 字
//   三个成功都回 True
// 日志只记 method 名＋状态码，绝不记 bot token、邮箱、用户 token。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { getUser, bearer } from '../_shared/user.ts';
import { tgBotTokenOk, tgBotCall } from '../_shared/telegram.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
};

const ADMIN_FAIL_MSG = '暂时无法完成，请稍后再试';
// 超时（审核 M1）：前端等 10 秒 → 查身份 2 + 查站主 2 + Bot API 3×1.5 = 8.5 秒
const ADMIN_USER_MS = 2000;
const ADMIN_RPC_MS = 2000;
const ADMIN_BOT_MS = 1500;
const APP_URL = 'https://jizhang.adteoh.com/';
// 计划 Q4（用户同意）
const MENU_TEXT = '记账';
const SHORT_DESC = '快速记账：点下方「记账」用邮箱登录（第一次需要邀请码）。';
const LONG_DESC = '点下方「记账」按钮，用邮箱验证码登录并连接这个 Telegram，就能在这里记账、看统计，和手机上的记账 App 是同一本账。第一次使用需要邀请码。';

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

  const token = bearer(req);
  if (!token) return reply(401, { error: '请重新登录后再试' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.action !== 'setup') {
    return reply(400, { error: '看不懂这个请求' });
  }

  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }
  const bot = deps.env('TELEGRAM_BOT_TOKEN');
  if (!tgBotTokenOk(bot)) {
    logFail('设定', 'bot token 不合格');
    return reply(500, { error: ADMIN_FAIL_MSG });
  }

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

  const steps: [string, unknown][] = [
    ['setChatMenuButton', { menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: APP_URL } } }],
    ['setMyShortDescription', { short_description: SHORT_DESC }],
    ['setMyDescription', { description: LONG_DESC }],
  ];
  for (const [method, payload] of steps) {
    const r = await tgBotCall(deps.fetch, bot, method, payload, ADMIN_BOT_MS);
    if (!r.ok) {
      logFail(method, `HTTP ${r.status}`);
      return reply(502, { error: 'Telegram 暂时连不上，请稍后再试' });
    }
  }
  return reply(200, { ok: true });
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleTgAdmin(req, realDeps()));
