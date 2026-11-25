// 同步引擎（2e）。这一段：认领本地账本（第一次登录时把这台设备的账本归给这个账号）。
// 规则：只有 meta.owner_user_id === session.user_id 才同步——绝不把别人的账传到这个账号。

/** 'mine'（属于这个账号）| 'unclaimed'（还没归属）| 'other'（属于别的账号）。 */
export async function claimState(store, session) {
  const owner = await store.getMeta('owner_user_id');
  if (!owner) return 'unclaimed';
  return owner === session.user_id ? 'mine' : 'other';
}

/** 认领：全部列标待上传，并在同一次写入里写 owner（中途失败就什么都没写，下次重来）。 */
export function claim(store, session) {
  return store.markAllForUpload({ meta: { owner_user_id: session.user_id } });
}

const DISMISSED = 'syncPromptDismissed'; // 关掉提醒的账号 id（下次启动不再自动问）

/**
 * 需要时认领。回 claimState 的结果。
 * - 没有账（只有默认分类）→ 直接认领，不问。
 * - 有账 → ask(N 笔账) 回 'start' 才认领；其他（关掉）→ 记下来，之后自动启动不再问。
 * - fromUser：用户在设置页按「开始」→ 不看「关掉过」，照样问。
 */
export async function ensureClaimed(store, session, { ask, fromUser = false }) {
  const st = await claimState(store, session);
  if (st !== 'unclaimed') return st;
  const n = store.transactions().length;
  if (n > 0) {
    if (!fromUser && (await store.getMeta(DISMISSED)) === session.user_id) return 'unclaimed';
    const answer = await ask(n);
    const now = await claimState(store, session); // 问的时候别的分页可能已处理
    if (now !== 'unclaimed') return now;
    if (answer !== 'start') {
      await store.setMeta(DISMISSED, session.user_id);
      return 'unclaimed';
    }
  }
  await claim(store, session);
  return 'mine';
}
