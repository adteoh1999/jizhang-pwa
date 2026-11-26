// Telegram Mini App 登录（3b-3）：公开函数，只凭 initData。已连接就换一个 session 回去；没连接回 unlinked。
// 流程：
//   1. 验签（300 秒内才算新鲜）；只是太旧 → 用 86400 再验一次（过了就是「不新鲜」，只能回 stale／unlinked）
//   2. 新鲜：svc_tg_touch（顺便更新名字）；不新鲜：只读 svc_tg_link_get（旧资料不能改名字）
//   3. 查账号 → mintSession → 再查一次连接（中途被解除就作废刚铸的 session）
// 规则：mintSession 成功之后，任何没把 token 回给前端的出口都先 revokeSession。
// 日志只记「哪一步＋原因种类／rpc 固定文字」，绝不记 initData、telegram_id、token、邮箱、名字、user id。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { adminGetUser, mintSession, revokeSession } from '../_shared/user.ts';
import { tgBotTokenOk, tgVerifyInitDataWhy } from '../_shared/telegram.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowSec?: () => number;
};

const FRESH_SEC = 300;          // 换 session 要 300 秒内的 initData
const STALE_SEC = 86400;        // 只回「没连接／stale」可以到 24 小时
const TG_BIND_MAX_SEC = 600;    // tg-link bind 的时效（bindLeft 用）
const RPC_MS = 3000;
const FAIL_MSG = '暂时无法登录，请稍后再试';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logFail = (step: string, detail: string) => console.error(`[tg-login] ${step}: ${detail}`);
// rpc 抛的讯息是自己写的固定文字（函数名＋状态码），可以记；其他错误一律只记「失败」
const errText = (e: unknown) => (e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');

export async function handleTgLogin(req: Request, deps: Deps): Promise<Response> {
  const cors = { ...corsHeaders(req.headers.get('Origin')), 'Cache-Control': 'no-store' };
  const reply = (status: number, obj: unknown) => json(status, obj, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  const initData = input && typeof input === 'object' && !Array.isArray(input) ? input.initData : undefined;
  if (typeof initData !== 'string') return reply(400, { error: '看不懂这个请求' });

  const bot = deps.env('TELEGRAM_BOT_TOKEN');
  if (!tgBotTokenOk(bot)) {
    logFail('设定', 'bot token 不合格');
    return reply(500, { error: FAIL_MSG });
  }
  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: FAIL_MSG });
  }

  // ---- 1. 验签 ----
  const now = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000);
  let v = await tgVerifyInitDataWhy(initData, bot, now, FRESH_SEC);
  let fresh = true;
  if ('fail' in v && v.fail === 'expired') {
    v = await tgVerifyInitDataWhy(initData, bot, now, STALE_SEC);
    fresh = false;
  }
  if ('fail' in v) {
    logFail('验证', v.fail);
    return v.fail === 'token' ? reply(500, { error: FAIL_MSG }) : reply(401, { error: '无法确认 Telegram 身份' });
  }
  const tid = Number(v.user.telegramId);
  const label = v.user.label;
  // 验签已确认 auth_date 是唯一、合格的数字
  const authDate = Number(new URLSearchParams(initData).get('auth_date'));
  const unlinked = () => reply(200, { status: 'unlinked', label, bindLeft: Math.max(0, authDate + TG_BIND_MAX_SEC - now) });

  const call = (name: string, args: unknown) => rpc(deps.fetch, base, key, name, args, RPC_MS);
  const asUid = (x: unknown, name: string): string | null => {
    if (x === null) return null;
    if (typeof x === 'string' && UUID_RE.test(x)) return x.toLowerCase();
    throw new Error(`rpc ${name} 失败：回传格式不对`);
  };

  // ---- 2、3. 找连接 ----
  let uid: string | null;
  try {
    uid = fresh
      ? asUid(await call('svc_tg_touch', { p_telegram_id: tid, p_label: label }), 'svc_tg_touch')
      : asUid(await call('svc_tg_link_get', { p_telegram_id: tid }), 'svc_tg_link_get');
  } catch (e) {
    logFail('找连接', errText(e));
    return reply(500, { error: FAIL_MSG });
  }
  if (uid === null) return unlinked();
  if (!fresh) return reply(200, { status: 'stale' });

  // ---- 4. 查账号 ----
  const acct = await adminGetUser(deps.fetch, base, key, uid);
  if (acct === 'gone') return unlinked();
  if (acct === 'error') {
    logFail('查账号', '失败');
    return reply(500, { error: FAIL_MSG });
  }
  if (acct.kind !== 'email' || acct.email === '') {
    logFail('查账号', '不是邮箱账号');
    return reply(500, { error: FAIL_MSG });
  }

  // ---- 5. 铸 session ----
  const s = await mintSession(deps.fetch, base, key, acct.email, uid);
  if (s === 'limited') {
    logFail('换 session', 'limited');
    return reply(429, { error: '请 1 分钟后再试' });
  }
  if (s === 'mismatch' || s === 'error') {
    logFail('换 session', s);
    return reply(500, { error: FAIL_MSG });
  }

  // ---- 6. 再查一次连接（从这里开始，没回 token 的出口都要先作废 session） ----
  let still: string | null;
  try {
    still = asUid(await call('svc_tg_link_get', { p_telegram_id: tid }), 'svc_tg_link_get');
  } catch (e) {
    logFail('再查连接', errText(e));
    if (!(await revokeSession(deps.fetch, base, key, s.access_token))) logFail('作废 session', '失败');
    return reply(500, { error: FAIL_MSG });
  }
  if (still !== uid) {
    logFail('再查连接', '连接已改变，作废新 session');
    if (!(await revokeSession(deps.fetch, base, key, s.access_token))) logFail('作废 session', '失败');
    return unlinked();
  }

  // ---- 7. ----
  return reply(200, {
    status: 'linked', access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in,
    user: { id: s.user.id, email: s.user.email }, label,
  });
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleTgLogin(req, realDeps()));
