// Telegram Mini App 登录（3b-3）：公开函数，只凭 initData。已连接就换一个 session 回去；没连接回 unlinked。
// 流程：
//   1. 验签（300 秒内才算新鲜）；只是太旧 → 用 86400 再验一次（过了就是「不新鲜」，只能回 stale／unlinked）
//   2. 新鲜：svc_tg_touch（顺便更新名字）；不新鲜：只读 svc_tg_link_get（旧资料不能改名字）
//   3. 查账号 → mintSession → 再查一次连接（中途被解除就作废刚铸的 session）
//   4. 连接时没寄成的通知信，在这里补寄（攻击者要拿 session 一定经过这里）
// 规则：mintSession 成功之后，任何没把 token 回给前端的出口都先 revokeSession（包括意外错误）。
// 总时限（审核 M1）：前端只等 10 秒，所以整个流程限 7.5 秒；铸好 session 后若已超时就作废、不回 token，
//   免得 token 回给已经放弃的前端、没人作废。作废本身另给 1.5 秒。
// 日志只记「哪一步＋原因种类／rpc 固定文字」，绝不记 initData、telegram_id、token、邮箱、名字、user id。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { adminGetUser, mintSession, revokeSession } from '../_shared/user.ts';
import { tgBotTokenOk, tgVerifyInitDataWhy, TG_BIND_MAX_SEC } from '../_shared/telegram.ts';
import { noticeLinkedOnce } from '../_shared/notice.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowSec?: () => number;
  nowMs?: () => number;
};

const FRESH_SEC = 300;          // 换 session 要 300 秒内的 initData
const STALE_SEC = 86400;        // 只回「没连接／stale」可以到 24 小时
const LOGIN_BUDGET_MS = 7500;   // 整个流程的总时限
const RPC_MS = 2000;
const ADMIN_MS = 2000;
const MINT_STEP_MS = 2500;      // generate_link、verify 各一次
const REVOKE_MS = 1500;
const NOTICE_RPC_MS = 1500;
const NOTICE_MAIL_MS = 2500;
const NOTICE_MIN_LEFT_MS = 3000; // 剩下不到这么多就不寄（下次打开再试）
const FAIL_MSG = '暂时无法登录，请稍后再试';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logFail = (step: string, detail: string) => console.error(`[tg-login] ${step}: ${detail}`);
// rpc 抛的讯息是自己写的固定文字（函数名＋状态码），可以记；其他错误一律只记「失败」
const errText = (e: unknown) => (e instanceof Error && e.message.startsWith('rpc ') ? e.message : '失败');

export async function handleTgLogin(req: Request, deps: Deps): Promise<Response> {
  const cors = { ...corsHeaders(req.headers.get('Origin')), 'Cache-Control': 'no-store' };
  const reply = (status: number, obj: unknown) => json(status, obj, cors);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  // 铸出、但还没交给前端的 session；意外错误时由最外层作废
  const minted = { token: '', base: '', key: '' };
  try {
    return await tgLoginFlow(req, deps, reply, minted);
  } catch {
    logFail('意外错误', '失败');
    if (minted.token) await revokeQuiet(deps, minted.base, minted.key, minted.token);
    return reply(500, { error: FAIL_MSG });
  }
}

async function revokeQuiet(deps: Deps, base: string, key: string, token: string): Promise<void> {
  if (!(await revokeSession(deps.fetch, base, key, token, REVOKE_MS))) logFail('作废 session', '失败');
}

async function tgLoginFlow(
  req: Request, deps: Deps, reply: (status: number, obj: unknown) => Response,
  minted: { token: string; base: string; key: string },
): Promise<Response> {
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  const clock = deps.nowMs ?? (() => Date.now());
  const deadline = clock() + LOGIN_BUDGET_MS;
  const left = () => deadline - clock();
  const at = (cap: number) => Math.max(1, Math.min(cap, left()));

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
    return v.fail === 'token' ? reply(500, { error: FAIL_MSG }) : reply(403, { code: 'tg_invalid', error: '无法确认 Telegram 身份' });
  }
  const tid = Number(v.user.telegramId);
  const label = v.user.label;
  // 验签已确认 auth_date 是唯一、合格的数字
  const authDate = Number(new URLSearchParams(initData).get('auth_date'));
  const unlinked = () => reply(200, { status: 'unlinked', label, bindLeft: Math.max(0, authDate + TG_BIND_MAX_SEC - now) });

  const call = (name: string, args: unknown, cap = RPC_MS) => rpc(deps.fetch, base, key, name, args, at(cap));
  const getUid = async (name: string, args: unknown): Promise<string | null> => {
    const x = await rpc(deps.fetch, base, key, name, args, at(RPC_MS), { emptyOk: false });
    if (x === null) return null;
    if (typeof x === 'string' && UUID_RE.test(x)) return x.toLowerCase();
    throw new Error(`rpc ${name} 失败：回传格式不对`);
  };

  // ---- 2、3. 找连接 ----
  let uid: string | null;
  try {
    uid = fresh
      ? await getUid('svc_tg_touch', { p_telegram_id: tid, p_label: label })
      : await getUid('svc_tg_link_get', { p_telegram_id: tid });
  } catch (e) {
    logFail('找连接', errText(e));
    return reply(500, { error: FAIL_MSG });
  }
  if (uid === null) return unlinked();
  if (!fresh) return reply(200, { status: 'stale' });

  // ---- 4. 查账号 ----
  const acct = await adminGetUser(deps.fetch, base, key, uid, at(ADMIN_MS));
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
  const s = await mintSession(deps.fetch, base, key, acct.email, uid, Math.max(1, Math.min(MINT_STEP_MS, Math.floor(left() / 2))));
  if (s === 'limited') {
    logFail('换 session', 'limited');
    return reply(429, { error: '请 1 分钟后再试' });
  }
  if (s === 'mismatch' || s === 'error') {
    logFail('换 session', s);
    return reply(500, { error: FAIL_MSG });
  }
  // 从这里开始，没回 token 的出口都要先作废 session
  Object.assign(minted, { token: s.access_token, base, key });
  const giveUp = async (step: string, detail: string, res: Response) => {
    logFail(step, detail);
    await revokeQuiet(deps, base, key, s.access_token);
    minted.token = '';
    return res;
  };
  if (left() <= 0) return giveUp('换 session', '超过总时限，作废新 session', reply(500, { error: FAIL_MSG }));

  // ---- 6. 再查一次连接 ----
  let still: string | null;
  try {
    still = await getUid('svc_tg_link_get', { p_telegram_id: tid });
  } catch (e) {
    return giveUp('再查连接', errText(e), reply(500, { error: FAIL_MSG }));
  }
  if (still !== uid) return giveUp('再查连接', '连接已改变，作废新 session', unlinked());
  if (left() <= 0) return giveUp('再查连接', '超过总时限，作废新 session', reply(500, { error: FAIL_MSG }));

  // ---- 7. 补寄通知信（时间不够就留到下次） ----
  if (left() >= NOTICE_MIN_LEFT_MS) {
    const r = await noticeLinkedOnce(call, deps.fetch, deps.env, tid, uid, acct.email, { rpcMs: NOTICE_RPC_MS, mailMs: NOTICE_MAIL_MS, at });
    if (r !== 'sent' && r !== 'skip') logFail('通知信', r);
    if (left() <= 0) return giveUp('通知信', '超过总时限，作废新 session', reply(500, { error: FAIL_MSG }));
  }

  // ---- 8. ----
  minted.token = '';
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
