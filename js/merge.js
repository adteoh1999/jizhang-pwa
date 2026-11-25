// 拉取合并规则（2e-2，纯函数）。审核 M1：不看本机时钟，只比 updated_at。
import { normalizeTs } from './timefmt.js';
import { timeValue } from './model.js';

/**
 * 远端这列要不要盖掉本地？
 * - 远端 updated_at 看不懂 → 不采用（呼叫者跳过）
 * - 没有本地列 → 采用
 * - 本地 dirty（含 sync_error，还没传上去）→ 只有远端严格较新才采用（拉回的旧版不能盖掉未上传的改动）
 * - 本地不 dirty → 时间不同就采用（顺便纠正时钟快留下的未来时间）
 */
export function shouldTakeRemote(local, remote) {
  const ts = normalizeTs(remote && remote.updated_at);
  if (ts === null) return false;
  if (!local) return true;
  if (local.dirty === 1) return timeValue(ts) > timeValue(local.updated_at);
  return ts !== local.updated_at;
}
