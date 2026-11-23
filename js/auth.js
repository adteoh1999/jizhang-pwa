// 登录：调用 register / Auth（OTP）接口、把错误翻成中文、清理输入。
// fetch 由外面传进来（node 测试注入假的）。不打印任何回应内容或 token，出错只记「步骤 + 状态码」。
import { SUPABASE_URL, SUPABASE_KEY, REGISTER_URL } from './config.js';

const NET = '连不上网络，请检查后再试';
const SERVER = '服务器暂时有问题，请稍后再试';
const GENERIC = '出了点问题，请稍后再试';
const TOO_MANY = '尝试太多次，请稍后再试';
const DEFAULT_TIMEOUT_MS = 10_000;

// register 函数会回的中文句子（supabase/functions/register/index.ts）；只有这几句原样显示
const REGISTER_MESSAGES = ['邮箱格式不对', '需要有效的邀请码', TOO_MANY, '暂时无法注册，请稍后再试'];
// send-email 钩子的句子（svc_otp_reserve）：抓数字、由前端自己组句
const HOOK_SECONDS = /^请 (\d{1,4}) 秒后再试$/;
const HOOK_MINUTES = /^已达到上限，请 (\d{1,4}) 分钟后再试$/;
const HOOK_FIXED = ['今天的验证码已达上限，请明天再试', '这个邮箱今天已寄太多次验证码，请明天再试'];
const AUTH_SECONDS = /(\d{1,4}) seconds?/;

/** 去前后空白、转小写；不像邮箱回 ''。规则必须与 supabase/functions/_shared/normalize.ts 相同。 */
export function normalizeEmailInput(s) {
  if (typeof s !== 'string') return '';
  const e = s.trim().toLowerCase();
  if (e.length > 254 || /\s/.test(e)) return '';
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@') || at === e.length - 1) return '';
  return e;
}

/** 验证码只留数字、取前 6 个（「481 203」「481-203」都可以）。 */
export function cleanCode(s) {
  return typeof s === 'string' ? s.replace(/\D/g, '').slice(0, 6) : '';
}

const authMsg = (body) => {
  const m = body && (body.msg ?? body.message ?? body.error_description);
  return typeof m === 'string' ? m.trim() : '';
};

/** 从失败回应抓「几秒后可以再要」：Auth 自己的 60 秒限制，或钩子的「请 N 秒后再试」。没有回 null。 */
function retrySeconds(body) {
  const m = authMsg(body);
  if (body && body.error_code === 'over_email_send_rate_limit') {
    const x = AUTH_SECONDS.exec(m);
    return x ? Number(x[1]) : null;
  }
  const x = HOOK_SECONDS.exec(m);
  return x ? Number(x[1]) : null;
}

/** 把失败回应翻成给用户看的中文。kind：'register' | 'otp' | 'verify'。status 0 表示网络错或超时。 */
export function authErrorMessage(status, body, kind) {
  if (status === 0) return NET;
  if (kind === 'register' && body && REGISTER_MESSAGES.includes(body.error)) return body.error;
  const code = body ? body.error_code : undefined;
  const msg = authMsg(body);
  if (code === 'over_email_send_rate_limit') {
    const x = AUTH_SECONDS.exec(msg);
    return x ? `请 ${Number(x[1])} 秒后再试` : '请稍后再试';
  }
  let x = HOOK_SECONDS.exec(msg);
  if (x) return `请 ${Number(x[1])} 秒后再试`;
  x = HOOK_MINUTES.exec(msg);
  if (x) return `已达到上限，请 ${Number(x[1])} 分钟后再试`;
  if (HOOK_FIXED.includes(msg)) return msg;
  if (status === 429) return TOO_MANY;
  if (kind === 'verify' && (status === 400 || status === 401 || status === 403)) return '验证码不对或已过期';
  if (kind === 'otp' && code === 'otp_disabled') return '这个邮箱还没注册，请填邀请码';
  if (status >= 500) return SERVER;
  return GENERIC;
}

/** POST JSON；回 {status, body}。网络错或超时 status 为 0。超时用 AbortController（iOS 15 没有 AbortSignal.timeout）。 */
async function postJson(fetchFn, url, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON：只看状态码 */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

const fail = (step, kind, { status, body }) => {
  console.warn(`[auth] ${step} 失败：HTTP ${status}`);
  return { ok: false, status, errorCode: (body && body.error_code) || null, message: authErrorMessage(status, body, kind) };
};
const isOk = (status) => status >= 200 && status < 300;

/** 第一步：register（已有账号 / 站主 / 有效邀请码 → ok）。inviteCode 空白就不送。 */
export async function registerEmail(fetchFn, email, inviteCode, { timeoutMs } = {}) {
  const payload = { email };
  if (typeof inviteCode === 'string' && inviteCode.trim()) payload.invite_code = inviteCode;
  const r = await postJson(fetchFn, REGISTER_URL, payload, timeoutMs);
  return isOk(r.status) ? { ok: true } : fail('register', 'register', r);
}

/** 第二步：请 Auth 寄验证码（create_user:false，只寄给已存在的账号）。 */
export async function requestOtp(fetchFn, email, { timeoutMs } = {}) {
  const r = await postJson(fetchFn, `${SUPABASE_URL}/auth/v1/otp`, { email, create_user: false }, timeoutMs);
  if (isOk(r.status)) return { ok: true };
  return { ...fail('otp', 'otp', r), retrySec: retrySeconds(r.body) };
}

/** 第三步：验证 6 位数，成功回 session。 */
export async function verifyOtp(fetchFn, email, code, nowMs, { timeoutMs } = {}) {
  const r = await postJson(fetchFn, `${SUPABASE_URL}/auth/v1/verify`, { type: 'email', email, token: code }, timeoutMs);
  if (!isOk(r.status)) return fail('verify', 'verify', r);
  try {
    return { ok: true, session: toSession(r.body, email, nowMs) };
  } catch {
    console.warn('[auth] verify 回应缺栏位');
    return { ok: false, status: r.status, errorCode: null, message: GENERIC };
  }
}

/** Auth 回应 → 存本机的 session。缺 token 或 user.id 就 throw。expires_at 一律存毫秒。 */
export function toSession(body, fallbackEmail, nowMs) {
  const b = body || {};
  const userId = b.user && b.user.id;
  if (typeof b.access_token !== 'string' || !b.access_token
    || typeof b.refresh_token !== 'string' || !b.refresh_token
    || typeof userId !== 'string' || !userId) {
    throw new Error('session 不完整');
  }
  const expiresAt = Number.isFinite(b.expires_at) ? b.expires_at * 1000
    : nowMs + (Number.isFinite(b.expires_in) ? b.expires_in : 3600) * 1000;
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: expiresAt,
    user_id: userId,
    email: (b.user && typeof b.user.email === 'string' && b.user.email) || fallbackEmail,
    platform: 'pwa',
  };
}

// ---------- 存本机（IndexedDB meta）----------
// session：登录后的 token；loginPending：「等待输入验证码」（切去邮件 App、PWA 被重载后还能回来）；
// lastUserId：上次登录的账号（登出不清；换账号时提醒，2e 认领本地资料也用它）。
export const OTP_TTL_MS = 600_000; // 验证码 10 分钟有效（Supabase 后台设定 600 秒）
export const RESEND_MS = 60_000;   // 60 秒后才能重发

const isStr = (v) => typeof v === 'string' && v.length > 0;

export async function loadSession(store) {
  const s = await store.getMeta('session');
  if (!s || !isStr(s.access_token) || !isStr(s.refresh_token) || !isStr(s.user_id) || !Number.isFinite(s.expires_at)) return null;
  return s;
}
export const saveSession = (store, s) => store.setMeta('session', s);
export const clearSession = (store) => store.setMeta('session', null);

/** 回 {email, sentAt, expired} 或 null。 */
export async function loadPending(store, nowMs) {
  const p = await store.getMeta('loginPending');
  if (!p || !isStr(p.email) || !Number.isFinite(p.sentAt)) return null;
  return { email: p.email, sentAt: p.sentAt, expired: nowMs - p.sentAt >= OTP_TTL_MS };
}
export const savePending = (store, { email, sentAt }) => store.setMeta('loginPending', { email, sentAt });
export const clearPending = (store) => store.setMeta('loginPending', null);

export async function loadLastUserId(store) {
  const v = await store.getMeta('lastUserId');
  return isStr(v) ? v : null;
}
export const saveLastUserId = (store, id) => store.setMeta('lastUserId', id);

/** 启动时要显示什么：没有 session → 登录页；有（就算过期）→ App（本地优先，token 刷新是 2e 的事）。 */
export function bootTarget(session) {
  return session ? 'app' : 'login';
}

/**
 * 登出（2d 最简单版）：只清登录状态，账本与 lastUserId 保留（用户决定：同步做好前账本是唯一一份）。
 * 清 session 成功才调 reload；失败回 false（呼叫者显示「登出失败」）。
 */
export async function signOut(store, reload) {
  try {
    await clearSession(store);
  } catch (e) {
    console.warn(`[auth] 登出写入失败：${e && e.name ? e.name : '未知'}`);
    return false;
  }
  // session 已清就算登出；pending 清不掉只记日志（下次打开登录页会照常判断过期）
  await clearPending(store).catch((e) => console.warn(`[auth] 清 pending 失败：${e && e.name ? e.name : '未知'}`));
  reload();
  return true;
}
