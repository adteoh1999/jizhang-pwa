// 站主管理（invites）与删除账号（delete-account）的前端客户端（2f）。
// fetch 由外面传进来（测试注入假的）。不打印 token 或回应内容。
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const NET = '需要网络';
const GENERIC = '暂时无法完成，请稍后再试';
// 服务器会回的中文句子（supabase/functions/invites、delete-account）；只有这几句原样显示，其他换成 GENERIC
const SERVER_MESSAGES = [
  '请重新登录后再试', '暂时无法删除，请稍后再试', GENERIC, '没有权限', '设定不正确',
  '找不到这个邀请码', '找不到这个用户', '不能移除站主', '看不懂这个请求',
];
const INVITES_TIMEOUT_MS = 10_000;
const REMOVE_USER_TIMEOUT_MS = 30_000; // 服务器最坏约 19 秒（查身份、站主、明细、删资料、删账号）
const DELETE_TIMEOUT_MS = 20_000;

// 回 {status, body, timeout}；网络错或超时 status 0，自己的计时器到期才是 timeout（2f-2 审核 3：
// 超时时服务器可能已经做完，和断网要分开）。超时用 AbortController（iOS 15 没有 AbortSignal.timeout）
async function post(fetchFn, name, accessToken, payload, timeoutMs) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  try {
    const res = await fetchFn(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    // 读内容时计时器到期（标头已到、内容被中止）也算超时：服务器多半已经做完。
    // 内容刚好读完的同一刻到期 → 用读到的（不丢掉成功的回应）
    if (timedOut && body === null) return { status: 0, body: null, timeout: true };
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null, timeout: timedOut };
  } finally {
    clearTimeout(timer);
  }
}

const failOf = ({ status, body }) => ({
  ok: false,
  status,
  error: status === 0 ? NET : (body && SERVER_MESSAGES.includes(body.error) ? body.error : GENERIC),
});
const isOk = (status) => status >= 200 && status < 300;

/**
 * 叫 invites：{ok:true, data} 或 {ok:false, status, error[, timeout:true]}。2xx 但内容不是 JSON 当失败。
 * timeout：自己的计时器到期（2f-3：移除用户超时时服务器可能已经删了，画面要跟断网分开说）。
 */
export async function callInvites(fetchFn, accessToken, action, args = {}, { timeoutMs } = {}) {
  const ms = timeoutMs ?? (action === 'remove_user' ? REMOVE_USER_TIMEOUT_MS : INVITES_TIMEOUT_MS);
  const r = await post(fetchFn, 'invites', accessToken, { ...args, action }, ms);
  if (isOk(r.status) && r.body && typeof r.body === 'object') return { ok: true, data: r.body };
  if (isOk(r.status)) return { ok: false, status: r.status, error: GENERIC };
  console.warn(`[admin] invites ${action} 失败：HTTP ${r.status}${r.timeout ? '（超时）' : ''}`);
  return r.timeout ? { ...failOf(r), timeout: true } : failOf(r);
}

/**
 * 叫 delete-account：{ok:true} 或 {ok:false, status, error[, timeout:true]}。
 * 要回 {ok:true} 才算删了（2f-2 审核 6：别的 2xx——例如中间的代理回空白页——当通用失败）。
 * timeout：等不到回应（服务器可能已经删了，呼叫的人可以再叫一次：账号不在了服务器也回 200）。
 */
export async function deleteAccount(fetchFn, accessToken, { timeoutMs = DELETE_TIMEOUT_MS } = {}) {
  const r = await post(fetchFn, 'delete-account', accessToken, {}, timeoutMs);
  if (isOk(r.status) && r.body && r.body.ok === true) return { ok: true };
  if (isOk(r.status)) return { ok: false, status: r.status, error: GENERIC };
  console.warn(`[admin] delete-account 失败：HTTP ${r.status}${r.timeout ? '（超时）' : ''}`);
  return r.timeout ? { ...failOf(r), timeout: true } : failOf(r);
}
