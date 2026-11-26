// 设置页「Telegram」列的状态快取（3b-10，照 owner-check.js）：meta tgStatus = {userId, linked, label, checkedAt}。
// 快取绑账号：userId 对不上就当没有。设置页 enter()（启动、回前景、打开设置页）时需要才问服务器（Q7）。
import { tgLink } from './tg-api.js';
import { getValidSession, loadSession } from './auth.js';

export const TG_STATUS_KEY = 'tgStatus';
export const TG_STATUS_MS = 5 * 60 * 1000; // 最多 5 分钟问一次（force 例外：刚解除连接）

const defaultOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true);

/** 快取里这个账号的 Telegram 状态；没有、别的账号的 → null。 */
export async function readTgStatus(store, userId) {
  const s = await store.getMeta(TG_STATUS_KEY);
  if (!s || s.userId !== userId || typeof s.linked !== 'boolean') return null;
  return { linked: s.linked, label: typeof s.label === 'string' ? s.label : '' };
}

let inflight = null; // 回前景、打开设置页可能同时叫：共用同一次（force 另外跑）

/**
 * 需要时问服务器（tg-link status），回 {linked, label}（已更新快取）或 null（跳过或失败，快取不动）。
 * 跳过：离线、5 分钟内问过（force 除外）、拿不到可用的登录、登录的已不是 userId。回应晚到而途中换了账号 → 不写。不会 reject。
 */
export function refreshTgStatus(store, opts = {}) {
  if (opts.force) return run(store, opts);
  if (!inflight) inflight = run(store, opts).finally(() => { inflight = null; });
  return inflight;
}

async function run(store, { fetchFn, userId, now = Date.now, isOnline = defaultOnline, getSession, force = false, tgLinkFn = tgLink } = {}) {
  try {
    if (!isOnline()) return null;
    const t = now();
    const s = await store.getMeta(TG_STATUS_KEY);
    if (!force && s && s.userId === userId && t >= s.checkedAt && t - s.checkedAt < TG_STATUS_MS) return null;
    const got = await (getSession ? getSession() : getValidSession(store, fetchFn));
    if (!got || !got.session || got.session.user_id !== userId) return null;
    const r = await tgLinkFn(fetchFn, got.session.access_token, 'status');
    if (!r.ok || typeof r.data.linked !== 'boolean') return null;
    const value = { linked: r.data.linked, label: r.data.linked && typeof r.data.label === 'string' ? r.data.label : '' };
    const cur = await loadSession(store);
    if (!cur || cur.user_id !== userId) return null;
    await store.setMeta(TG_STATUS_KEY, { userId, ...value, checkedAt: t });
    return value;
  } catch (e) {
    console.warn(`[tg] 读 Telegram 状态失败：${e && e.name ? e.name : '未知'}`);
    return null;
  }
}
