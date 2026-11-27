// Telegram 三个 Edge Function（tg-login、tg-link、tg-admin）的前端客户端（3b-7）。
// fetch 由外面传进来（测试注入假的）。日志只记「函数名／动作＋状态码」，不印 token、initData 或回应内容。
// 服务器的中文句子只有列在白名单里的才原样显示，其他换成通用句。
import { SUPABASE_KEY, TG_LOGIN_URL, TG_LINK_URL, TG_ADMIN_URL } from './config.js';
import { toSession } from './auth.js';

const NET = '需要网络';
const GENERIC = '暂时无法完成，请稍后再试';
const LOGIN_TIMEOUT_MS = 15_000;   // 服务器总时限 7.5 秒＋作废 1.5 秒
const BIND_TIMEOUT_MS = 15_000;    // 服务器最长约 13.5 秒
const LINK_TIMEOUT_MS = 10_000;
const ADMIN_TIMEOUT_MS = 25_000;   // 服务器总时限 18 秒＋网络慢的余裕（用户决定 11）

const LOGIN_MESSAGES = ['无法确认 Telegram 身份', '请 1 分钟后再试', '暂时无法登录，请稍后再试', '看不懂这个请求'];
const LINK_MESSAGES = [
  '请重新登录后再试', '没有权限', '暂时无法连接，请稍后再试', '看不懂这个请求', '太久没有完成，请关掉再重新打开',
  '无法确认 Telegram 身份', '这个 Telegram 已连接另一个邮箱', '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接',
  '系统忙碌，请再试一次',
];
const LINK_CODES = ['init_stale', 'tg_invalid', 'telegram_taken', 'user_taken', 'busy'];
const ADMIN_MESSAGES = ['没有权限', '请重新登录后再试', 'Telegram 暂时连不上，请稍后再试', '看不懂这个请求'];

const isOk = (status) => status >= 200 && status < 300;
const isObj = (b) => !!b && typeof b === 'object' && !Array.isArray(b);
const pick = (body, list) => (isObj(body) && list.includes(body.error) ? body.error : GENERIC);

// 回 {status, body}；网络错或超时 status 0。超时用 AbortController（iOS 15 没有 AbortSignal.timeout）
async function post(fetchFn, url, accessToken, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      apikey: SUPABASE_KEY, 'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 initData 换登录：
 *   {ok:true, status:'linked', session, label} | {ok:true, status:'unlinked', label, bindDeadline} | {ok:true, status:'stale'}
 *   | {ok:false, kind:'invalid'|'limited'|'net'|'server', message}
 * bindDeadline：本机时间＋服务器算的 bindLeft 秒（不靠手机时钟）；没有 bindLeft → null。
 */
export async function tgLogin(fetchFn, initData, nowMs, { timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const { status, body } = await post(fetchFn, TG_LOGIN_URL, null, { initData }, timeoutMs);
  const label = isObj(body) && typeof body.label === 'string' ? body.label : '';
  if (status === 200 && isObj(body)) {
    if (body.status === 'linked') {
      try {
        const session = toSession(body, '', nowMs);
        if (session.email) return { ok: true, status: 'linked', session, label }; // 没有邮箱也当不完整（提示与设置页要用）
      } catch { /* 不完整 → 下面当 server */ }
    } else if (body.status === 'unlinked') {
      const left = body.bindLeft;
      return { ok: true, status: 'unlinked', label, bindDeadline: typeof left === 'number' && Number.isFinite(left) ? nowMs + left * 1000 : null };
    } else if (body.status === 'stale') {
      return { ok: true, status: 'stale' };
    }
  }
  console.warn(`[tg] tg-login 失败：HTTP ${status}`);
  if (status === 0) return { ok: false, kind: 'net', message: NET };
  if (status === 403 && isObj(body) && body.code === 'tg_invalid') return { ok: false, kind: 'invalid', message: pick(body, LOGIN_MESSAGES) };
  if (status === 429) return { ok: false, kind: 'limited', message: pick(body, LOGIN_MESSAGES) };
  return { ok: false, kind: 'server', message: pick(body, LOGIN_MESSAGES) };
}

/**
 * 叫 tg-link：{ok:true, data} | {ok:false, status, code, error, retry}
 * retry：网络错、超时、5xx（含 503 busy）、429、2xx 但内容不对——都不是明确答案，呼叫端不能据此清资料。
 */
export async function tgLink(fetchFn, accessToken, action, { initData, timeoutMs } = {}) {
  const ms = timeoutMs ?? (action === 'bind' ? BIND_TIMEOUT_MS : LINK_TIMEOUT_MS);
  const payload = { action };
  if (initData !== undefined) payload.initData = initData;
  const { status, body } = await post(fetchFn, TG_LINK_URL, accessToken, payload, ms);
  if (isOk(status) && isObj(body)) return { ok: true, data: body };
  console.warn(`[tg] tg-link ${action} 失败：HTTP ${status}`);
  if (status === 0) return { ok: false, status: 0, code: null, error: NET, retry: true };
  const code = isObj(body) && LINK_CODES.includes(body.code) ? body.code : null;
  const retry = isOk(status) || status >= 500 || status === 429; // 429：稍后再按一次就好，不是明确失败
  return { ok: false, status, code, error: pick(body, LINK_MESSAGES), retry };
}

async function adminAction(fetchFn, accessToken, action, timeoutMs) {
  const { status, body } = await post(fetchFn, TG_ADMIN_URL, accessToken, { action }, timeoutMs);
  if (isOk(status) && isObj(body) && body.ok === true) return { ok: true, body };
  console.warn(`[tg] tg-admin ${action} 失败：HTTP ${status}`);
  return { ok: false, error: status === 0 ? NET : pick(body, ADMIN_MESSAGES) };
}

/** 站主设定 bot（选单按钮、简介、webhook、指令）：{ok:true} | {ok:false, error} */
export async function tgAdminSetup(fetchFn, accessToken, { timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
  const r = await adminAction(fetchFn, accessToken, 'setup', timeoutMs);
  return r.ok ? { ok: true } : r;
}

/** 站主暂停 bot（删掉 webhook、丢掉积压讯息）：{ok:true} | {ok:false, error} */
export async function tgAdminPause(fetchFn, accessToken, { timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
  const r = await adminAction(fetchFn, accessToken, 'pause', timeoutMs);
  return r.ok ? { ok: true } : r;
}

const STATUS_WEBHOOK = ['ok', 'wrong_url', 'none'];
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 站主检查 bot：{ok:true, data:{webhook, pending, lastErrorAt, aiUsed24h}} | {ok:false, error}（只取认得的栏位） */
export async function tgAdminStatus(fetchFn, accessToken, { timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
  const r = await adminAction(fetchFn, accessToken, 'status', timeoutMs);
  if (!r.ok) return r;
  const b = r.body;
  if (!STATUS_WEBHOOK.includes(b.webhook) || !isCount(b.pending) || !(b.aiUsed24h === null || isCount(b.aiUsed24h))
      || !(b.lastErrorAt === null || (typeof b.lastErrorAt === 'string' && ISO_RE.test(b.lastErrorAt) && !Number.isNaN(Date.parse(b.lastErrorAt))))) {
    console.warn('[tg] tg-admin status 回应格式不对');
    return { ok: false, error: GENERIC };
  }
  return { ok: true, data: { webhook: b.webhook, pending: b.pending, lastErrorAt: b.lastErrorAt, aiUsed24h: b.aiUsed24h } };
}
