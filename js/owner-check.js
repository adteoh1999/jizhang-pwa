// 站主判断（2f Task 7）：设置页要不要显示「邀请码管理」。真正的权限由服务器判断，这里只是快取。
// 快取绑账号（审核 M4）：meta ownerFlag = {userId, value, checkedAt}；userId 对不上就当没有。
import { callInvites, DENIED_ERROR } from './admin-api.js';
import { getValidSession, loadSession } from './auth.js';

export const OWNER_FLAG_KEY = 'ownerFlag';
export const OWNER_CHECK_MS = 24 * 60 * 60 * 1000; // 最多一天问一次

const defaultOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true);

/** 快取里这个账号是不是站主（没有快取、别的账号的快取都当 false）。 */
export async function readOwnerFlag(store, userId) {
  const f = await store.getMeta(OWNER_FLAG_KEY);
  return !!f && f.userId === userId && f.value === true;
}

let inflight = null; // 回前景、打开设置页可能同时叫：共用同一次

/**
 * 需要时问服务器（invites check），回 true／false（已更新快取）或 null（跳过或失败，快取不动）。
 * 跳过：离线、同一账号 24 小时内问过、拿不到可用的登录、登录的已不是 userId。
 * 回应晚到而途中换了账号 → 不写（M4）。不会 reject。
 */
export function refreshOwnerFlag(store, opts) {
  if (!inflight) inflight = run(store, opts).finally(() => { inflight = null; });
  return inflight;
}

async function run(store, { fetchFn, userId, now = Date.now, isOnline = defaultOnline, getSession } = {}) {
  try {
    if (!isOnline()) return null;
    const f = await store.getMeta(OWNER_FLAG_KEY);
    const t = now();
    if (f && f.userId === userId && t >= f.checkedAt && t - f.checkedAt < OWNER_CHECK_MS) return null;
    const got = await (getSession ? getSession() : getValidSession(store, fetchFn));
    if (!got.session || got.session.user_id !== userId) return null;
    const r = await callInvites(fetchFn, got.session.access_token, 'check');
    let value;
    if (r.ok && typeof r.data.owner === 'boolean') value = r.data.owner;
    // 旧版服务器对非站主回 403「没有权限」；别的 403（平台、网关）不算，免得入口消失一整天（2f-3 审核 5）
    else if (!r.ok && r.status === 403 && r.error === DENIED_ERROR) value = false;
    else return null;
    const cur = await loadSession(store);
    if (!cur || cur.user_id !== userId) return null;
    await store.setMeta(OWNER_FLAG_KEY, { userId, value, checkedAt: t });
    return value;
  } catch (e) {
    console.warn(`[owner] 站主判断失败：${e && e.name ? e.name : '未知'}`);
    return null;
  }
}
