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
async function postJson(fetchFn, url, payload, timeoutMs = DEFAULT_TIMEOUT_MS, extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload ?? {}),
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
  // 优先「本机现在 + expires_in」：手机时钟不准时，用服务器的 expires_at 会让每轮都以为快过期（或一直不刷新）
  const expiresAt = Number.isFinite(b.expires_in) ? nowMs + b.expires_in * 1000
    : Number.isFinite(b.expires_at) ? b.expires_at * 1000
    : nowMs + 3600 * 1000;
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: expiresAt,
    user_id: userId,
    email: (b.user && typeof b.user.email === 'string' && b.user.email) || fallbackEmail,
    platform: 'pwa',
  };
}

// ---------- token 刷新（2e）----------
// 查证（GitHub supabase/auth internal/api/token_refresh.go、internal/tokens/service.go、apierrors/errorcode.go）：
// refresh token 失效一律 HTTP 400 + 下列 error_code。validation_failed（格式不对）不算失效，归「稍后重试」。
export const INVALID_REFRESH_CODES = Object.freeze([
  'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found',
  'session_expired', 'user_banned', 'user_not_found',
]);
const REFRESH_MARGIN_MS = 60_000; // 剩不到 60 秒就先刷新
const LOGOUT_TIMEOUT_MS = 2_000;
const AUTH_LOCK = 'jizhang-auth';

// 日志只印规矩的 error_code（服务器给的原字串可能很长或夹杂奇怪字元）
const safeCode = (code) => (code === null ? '' : /^[a-z0-9_]{1,64}$/.test(code) ? ` ${code}` : ' 其他');

/**
 * 换新 token。回 {ok:true, session} | {ok:false, invalid, status}。只有 400 + 名单内的 error_code 才算 invalid。
 * userId 给了而回来的账号不同 → 当成失败（retry），不存。
 */
export async function refreshSession(fetchFn, refreshToken, email, nowMs, { timeoutMs, userId } = {}) {
  const r = await postJson(fetchFn, `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, { refresh_token: refreshToken }, timeoutMs);
  const code = (r.body && typeof r.body.error_code === 'string') ? r.body.error_code : null;
  if (isOk(r.status)) {
    let session;
    try {
      session = toSession(r.body, email, nowMs);
    } catch {
      console.warn('[auth] 刷新回应缺栏位');
      return { ok: false, invalid: false, status: r.status };
    }
    if (userId && session.user_id !== userId) {
      console.warn('[auth] 刷新回来的账号不同，不采用');
      return { ok: false, invalid: false, status: r.status };
    }
    return { ok: true, session };
  }
  console.warn(`[auth] 刷新失败：HTTP ${r.status}${safeCode(code)}`);
  return { ok: false, invalid: r.status === 400 && INVALID_REFRESH_CODES.includes(code), status: r.status };
}

// 分页内的后备锁（没有 navigator.locks 时，例如 iOS 15.4 以前或非 HTTPS）
const localLocks = new Map();
function localLock(name, fn) {
  const prev = localLocks.get(name) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  localLocks.set(name, tail);
  tail.then(() => { if (localLocks.get(name) === tail) localLocks.delete(name); });
  return run;
}
/**
 * 拿锁执行 fn（跨分页用 Web Locks；没有就用分页内的 Promise 锁）。
 * 锁不能重入：拿着 jizhang-auth 锁时，不可以再调 getValidSession / signOut（会永远等）。
 */
export function withLock(name, fn, locks = globalThis.navigator && globalThis.navigator.locks) {
  if (locks && typeof locks.request === 'function') return locks.request(name, () => fn());
  return localLock(name, fn);
}

const errName = (e) => (e && e.name ? e.name : '未知');

/**
 * 拿到可以用的 session（必要时刷新）。回 {session} | {invalid:true} | {retry:true}，不会 reject。
 * 任何要用 access token 的地方都只能经过这里，不要自己 loadSession 后拿 token 去用。
 * failedToken：刚被服务器 401 拒绝的 access token。锁内重读后若已不同（别的分页刚刷新）且没快过期就直接用；
 * 相同就强制刷新。失效时把 session 标成 invalid（不删：用户决定 1，账本照常用、同步暂停），
 * 之后不再发刷新请求，直到重新登录（存新 session 时 invalid 自然消失）。
 */
export async function getValidSession(store, fetchFn, { now = Date.now, locks, failedToken = null } = {}) {
  try {
    return await withLock(AUTH_LOCK, async () => {
      let s;
      try {
        s = await loadSession(store);
      } catch (e) {
        console.warn(`[auth] 读取登录状态失败：${errName(e)}`);
        return { retry: true };
      }
      if (!s || s.invalid) return { invalid: true };
      const t = now();
      const fresh = s.expires_at - t > REFRESH_MARGIN_MS;
      if (failedToken ? (s.access_token !== failedToken && fresh) : fresh) return { session: s };
      const r = await refreshSession(fetchFn, s.refresh_token, s.email, t, { userId: s.user_id });
      if (r.ok) {
        try {
          await saveSession(store, r.session);
        } catch (e) {
          console.warn(`[auth] 存新登录状态失败：${errName(e)}`);
        }
        return { session: r.session };
      }
      if (!r.invalid) return { retry: true };
      // 标 invalid 前再读一次：途中别处（例如重新登录，不经过这把锁）已存了新的 → 用新的，不盖掉
      try {
        const cur = await loadSession(store);
        if (!cur) return { invalid: true }; // 途中被登出清掉：不写回旧的
        if (cur.refresh_token !== s.refresh_token) return cur.invalid ? { invalid: true } : { session: cur };
        await saveSession(store, { ...s, invalid: true });
      } catch (e) {
        console.warn(`[auth] 标记登录失效失败：${errName(e)}`);
      }
      return { invalid: true };
    }, locks);
  } catch (e) {
    console.warn(`[auth] 拿锁失败：${errName(e)}`);
    return { retry: true };
  }
}

/** 「重新登录」：只清本机 session（已失效，不通知服务器），走同一把锁，之后呼叫者重载到登录页。 */
export function forgetSession(store, { locks } = {}) {
  return withLock(AUTH_LOCK, () => clearSession(store), locks);
}

/**
 * 清空这台设备的账本（登出、删号共用，2f 审核 M2）：拿 jizhang-auth 锁再 store.wipeLocal()，
 * 才不会和正在进行的 token 刷新交错（刷新写回 session 会把刚清掉的登录又写回去）。
 * 锁不能重入：一定要在 getValidSession 回来之后才叫。拿锁失败就不用锁直接清（照 signOut）。
 * 回 true／false，不会 reject。
 */
export async function wipeLocalLocked(store, { locks } = {}) {
  const work = async () => {
    try {
      await store.wipeLocal();
      return true;
    } catch (e) {
      console.warn(`[auth] 清除本机资料失败：${errName(e)}`);
      return false;
    }
  };
  try {
    return await withLock(AUTH_LOCK, work, locks);
  } catch (e) {
    console.warn(`[auth] 清除拿锁失败：${errName(e)}`);
    return work();
  }
}

/** 通知服务器作废这台设备的 refresh token（尽力而为，2 秒超时，结果不管）。 */
export async function logoutServer(fetchFn, accessToken, { timeoutMs = LOGOUT_TIMEOUT_MS } = {}) {
  const r = await postJson(fetchFn, `${SUPABASE_URL}/auth/v1/logout?scope=local`, {}, timeoutMs,
    { Authorization: `Bearer ${accessToken}` });
  if (!isOk(r.status)) console.warn(`[auth] 服务器登出失败：HTTP ${r.status}`);
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
 * 登出：只清登录状态，账本与 lastUserId 保留（用户决定 4；清本地资料留到 2f）。
 * 顺序：先停同步 → 拿 jizhang-auth 锁（不与刷新同时进行）→ 在线就通知服务器作废 token（最多 2 秒）→ 清 session。
 * 清 session 成功才调 reload；失败回 false（呼叫者显示「登出失败」）。没给 fetchFn 就不通知服务器。
 */
export async function signOut(store, reload, { fetchFn, locks, stopSync, isOnline = () => globalThis.navigator ? globalThis.navigator.onLine !== false : true } = {}) {
  if (stopSync) {
    try { stopSync(); } catch { /* 停不了也照样登出 */ }
  }
  const work = async () => {
    if (fetchFn && isOnline()) {
      try {
        const s = await loadSession(store);
        if (s && !s.invalid) await logoutServer(fetchFn, s.access_token);
      } catch { /* 尽力而为 */ }
    }
    try {
      await clearSession(store);
      return true;
    } catch (e) {
      console.warn(`[auth] 登出写入失败：${errName(e)}`);
      return false;
    }
  };
  let cleared;
  try {
    cleared = await withLock(AUTH_LOCK, work, locks);
  } catch (e) {
    // 拿锁本身失败：登出一定要能成功，不用锁直接清
    console.warn(`[auth] 登出拿锁失败：${errName(e)}`);
    cleared = await work();
  }
  if (!cleared) return false;
  // session 已清就算登出；pending 清不掉只记日志（下次打开登录页会照常判断过期）
  await clearPending(store).catch((e) => console.warn(`[auth] 清 pending 失败：${e && e.name ? e.name : '未知'}`));
  reload();
  return true;
}
