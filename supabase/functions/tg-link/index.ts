// Telegram 连接管理（3b-4）：要用户 token（邮箱登录）。
//   bind   ：initData（600 秒内）＋这个账号 → svc_tg_bind；连接成功（linked／already）寄一次通知信
//   check  ：initData（86400 秒内）这个 Telegram 是否连着这个账号
//   status ：这个账号有没有连接、Telegram 名字
//   unlink ：解除连接，再登出这个账号的其他设备（可以重试）
// 日志只记「哪一步＋原因种类／状态码／rpc 固定文字」，绝不记 initData、telegram_id、token、邮箱、名字、user id。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { getUser, bearer, logoutOthers } from '../_shared/user.ts';
import { tgBotTokenOk, tgVerifyInitDataWhy, TG_BIND_MAX_SEC } from '../_shared/telegram.ts';
import { noticeLinkedOnce } from '../_shared/notice.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowSec?: () => number;
};

const CHECK_MAX_SEC = 86400;
const BIND_RPC_MS = 4000;      // 比 svc_tg_bind 的 lock_timeout 3 秒长
const LINK_RPC_MS = 3000;
const NOTICE_RPC_MS = 2000;     // 预约、撤回（审核 M1：bind 合计 3+4+2+2.5+2 = 13.5 秒 < 前端 15 秒）
const NOTICE_MAIL_MS = 2500;    // 照 send-email
const LINK_FAIL_MSG = '暂时无法连接，请稍后再试';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ['bind', 'check', 'status', 'unlink'];

const logFail = (step: string, detail: string) => console.error(`[tg-link] ${step}: ${detail}`);
// rpc 抛的讯息是自己写的固定文字（函数名＋状态码）；其他错误一律只记「失败」
const errText = (e: unknown) => (e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');

const BIND_REPLY: Record<string, [number, Record<string, string>]> = {
  telegram_taken: [409, { code: 'telegram_taken', error: '这个 Telegram 已连接另一个邮箱' }],
  user_taken: [409, { code: 'user_taken', error: '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接' }],
  no_user: [401, { error: '请重新登录后再试' }],
  not_email: [403, { error: '没有权限' }],
};

export async function handleTgLink(req: Request, deps: Deps): Promise<Response> {
  const cors = { ...corsHeaders(req.headers.get('Origin')), 'Cache-Control': 'no-store' };
  const reply = (status: number, obj: unknown) => json(status, obj, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    return await tgLinkFlow(req, deps, reply);
  } catch {
    logFail('意外错误', '失败');
    return reply(500, { error: LINK_FAIL_MSG });
  }
}

async function tgLinkFlow(req: Request, deps: Deps, reply: (status: number, obj: unknown) => Response): Promise<Response> {
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  const token = bearer(req);
  if (!token) return reply(401, { error: '请重新登录后再试' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  const ok = input && typeof input === 'object' && !Array.isArray(input);
  const action = ok && typeof input.action === 'string' ? input.action : '';
  if (!ACTIONS.includes(action)) return reply(400, { error: '看不懂这个请求' });
  const needTg = action === 'bind' || action === 'check';
  const initData = input.initData;
  if (needTg && typeof initData !== 'string') return reply(400, { error: '看不懂这个请求' });

  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: LINK_FAIL_MSG });
  }
  const bot = deps.env('TELEGRAM_BOT_TOKEN');
  if (needTg && !tgBotTokenOk(bot)) {
    logFail('设定', 'bot token 不合格');
    return reply(500, { error: LINK_FAIL_MSG });
  }

  const user = await getUser(deps.fetch, base, key, token);
  if (user === 'gone' || user === 'unauthorized') return reply(401, { error: '请重新登录后再试' });
  if (user === 'error') {
    logFail('查身份', '失败');
    return reply(500, { error: LINK_FAIL_MSG });
  }
  if (user.kind !== 'email') return reply(403, { error: '没有权限' });

  const call = (name: string, args: unknown, ms = LINK_RPC_MS) => rpc(deps.fetch, base, key, name, args, ms);
  const tid = (tg: { telegramId: string }) => Number(tg.telegramId); // 验签已确认是安全整数
  const now = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000);

  // 验签：太旧 → 422 init_stale；bot token 不合格 → 500；其他 → 401
  const verify = async (maxAge: number) => {
    const v = await tgVerifyInitDataWhy(initData, bot, now, maxAge);
    if ('user' in v) return v.user;
    logFail('验证', v.fail);
    if (v.fail === 'expired') return reply(422, { code: 'init_stale', error: '太久没有完成，请关掉再重新打开' });
    if (v.fail === 'token') return reply(500, { error: LINK_FAIL_MSG });
    return reply(403, { code: 'tg_invalid', error: '无法确认 Telegram 身份' });
  };

  switch (action) {
    case 'bind': {
      const tg = await verify(TG_BIND_MAX_SEC);
      if (tg instanceof Response) return tg;
      const telegramId = tid(tg);
      let result: unknown;
      try {
        result = await call('svc_tg_bind', { p_telegram_id: telegramId, p_user_id: user.id, p_label: tg.label }, BIND_RPC_MS);
      } catch (e) {
        logFail('bind', errText(e));
        if ((e as { pgCode?: string })?.pgCode === '55P03') return reply(503, { code: 'busy', error: '系统忙碌，请再试一次' });
        return reply(500, { error: LINK_FAIL_MSG });
      }
      if (result === 'linked' || result === 'already') {
        const r = await noticeLinkedOnce(call, deps.fetch, deps.env, telegramId, user.id, user.email,
          { rpcMs: NOTICE_RPC_MS, mailMs: NOTICE_MAIL_MS, at: (cap) => cap });
        if (r !== 'sent' && r !== 'skip') logFail('通知信', r);
        return reply(200, { result });
      }
      if (typeof result === 'string' && result in BIND_REPLY) {
        const [status, body] = BIND_REPLY[result];
        return reply(status, body);
      }
      logFail('bind', '回传格式不对');
      return reply(500, { error: LINK_FAIL_MSG });
    }

    case 'check': {
      const tg = await verify(CHECK_MAX_SEC);
      if (tg instanceof Response) return tg;
      try {
        const uid = await rpc(deps.fetch, base, key, 'svc_tg_link_get', { p_telegram_id: tid(tg) }, LINK_RPC_MS, { emptyOk: false });
        const linked = typeof uid === 'string' && UUID_RE.test(uid) && uid.toLowerCase() === user.id.toLowerCase();
        return reply(200, { linked });
      } catch (e) {
        logFail('check', errText(e));
        return reply(500, { error: LINK_FAIL_MSG });
      }
    }

    case 'status': {
      try {
        const s: any = await call('svc_tg_status', { p_user_id: user.id });
        if (!s || typeof s !== 'object' || typeof s.linked !== 'boolean') throw new Error('rpc svc_tg_status 失败：回传格式不对');
        return reply(200, { linked: s.linked, label: s.linked && typeof s.label === 'string' ? s.label : '' });
      } catch (e) {
        logFail('status', errText(e));
        return reply(500, { error: LINK_FAIL_MSG });
      }
    }

    case 'unlink': {
      let unlinked: unknown;
      try {
        unlinked = await call('svc_tg_unlink', { p_user_id: user.id });
        if (typeof unlinked !== 'boolean') throw new Error('rpc svc_tg_unlink 失败：回传格式不对');
      } catch (e) {
        logFail('unlink', errText(e));
        return reply(500, { error: LINK_FAIL_MSG });
      }
      const others = await logoutOthers(deps.fetch, base, key, token);
      if (!others) logFail('登出其他设备', '失败');
      return reply(200, { ok: true, unlinked, others });
    }
  }
  return reply(400, { error: '看不懂这个请求' });
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleTgLink(req, realDeps()));
