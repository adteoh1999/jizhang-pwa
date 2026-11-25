// 设置页「删除账号和全部数据」（2f，spec §8.5）。两次确认：第一次可先导出 CSV，第二次要输入「删除」。
// 规格写 action sheet，这里刻意用 alert（choiceDialog）：「先导出 CSV」要在点击当下叫分享（keepOpen），action sheet 做不到。
// 流程：离线先挡 → 两次确认 → 拿可用的 session（拿不到就说明、什么都不动）→ 停同步与 Realtime
//      → 叫 delete-account → 成功：清本机（拿锁）、清隐藏金额、通知其他分页、告知已删除、重新整理（回登录页）
//      → 失败：说明原因、重新整理（同步重新开始，本机资料不动）。
import { choiceDialog, confirmDialog, messageDialog } from './dialogs.js';
import { createExporter } from './export-csv.js';
import { HIDE_KEY } from './home.js';
import { getValidSession, wipeLocalLocked, clearSession } from '../auth.js';
import { deleteAccount } from '../admin-api.js';
import { announceLedgerReset } from '../ledger-channel.js';

export const DELETE_TEXT = Object.freeze({
  rowLabel: '删除账号和全部数据',
  busyLabel: '正在删除…',
  offlineTitle: '需要网络才能删除账号',
  offlineMessage: '请连上网络后再试。',
  firstTitle: '删除账号和全部数据？',
  firstMessage: '会永久删除你在这台设备和云端的所有账单、分类和设置，无法复原。',
  exportLabel: '先导出 CSV',
  continueLabel: '继续',
  cancelLabel: '取消',
  secondTitle: '确定永久删除？',
  secondMessage: '请输入「删除」以确认。',
  requireText: '删除',
  confirmLabel: '永久删除',
  reloginTitle: '请重新登录后再试',
  reloginMessage: '登录已过期，重新登录后才能删除账号。',
  retryTitle: '暂时连不上',
  retryMessage: '请稍后再试。',
  failTitle: '没能删除账号',
  doneTitle: '账号已删除',
  doneMessage: '你的账号和全部数据都已删除。',
  partialMessage: '但这台设备的资料没清掉，请重新整理后再登出一次。',
});
const T = DELETE_TEXT;

/** 设置页最下面那一区的列（纯函数）：有登录才显示。 */
export function dangerRows(session) {
  return session ? [{ kind: 'delete-account', label: T.rowLabel }] : [];
}

let running = false;

/**
 * 跑一次删除账号流程。回 'done' | 'cancel' | 'fail'。正在跑时再叫直接回 'cancel'。
 * deps：store、sync、realtime、fetchFn、isOnline、reload、onBusy(bool)；测试另可注入 dialogs、storage、announce、exportCsv、locks。
 */
export async function runDeleteAccount(deps) {
  if (running) return 'cancel';
  running = true;
  try {
    return await flow(deps);
  } finally {
    running = false;
  }
}

async function flow({
  store, sync = null, realtime = null, fetchFn, reload,
  isOnline = () => globalThis.navigator ? globalThis.navigator.onLine !== false : true,
  onBusy = () => {},
  dialogs = { choiceDialog, confirmDialog, messageDialog },
  storage = globalThis.localStorage,
  announce = announceLedgerReset,
  exportCsv = createExporter(store),
  locks,
}) {
  if (!isOnline()) {
    await dialogs.messageDialog({ title: T.offlineTitle, message: T.offlineMessage });
    return 'cancel';
  }
  const first = await dialogs.choiceDialog({
    title: T.firstTitle,
    message: T.firstMessage,
    // 直排三个；焦点放「取消」（删除撤不回，Enter 不该往下走）
    buttons: [
      { label: T.exportLabel, keepOpen: true, onClick: exportCsv },
      { label: T.continueLabel, value: 'continue', destructive: true },
      { label: T.cancelLabel, value: 'cancel', focus: true },
    ],
  });
  if (first !== 'continue') return 'cancel';
  const sure = await dialogs.confirmDialog({
    title: T.secondTitle, message: T.secondMessage, requireText: T.requireText,
    confirmLabel: T.confirmLabel, destructive: true,
  });
  if (!sure) return 'cancel';

  // 先拿 session（审核 S14）：拿不到就什么都不动，同步照常
  const got = await getValidSession(store, fetchFn, { locks });
  if (!got.session) {
    if (got.invalid) await dialogs.messageDialog({ title: T.reloginTitle, message: T.reloginMessage });
    else await dialogs.messageDialog({ title: T.retryTitle, message: T.retryMessage });
    return 'fail';
  }
  try { if (sync) sync.stop(); } catch { /* 停不了也照样往下 */ }
  try { if (realtime) realtime.stop(); } catch { /* 同上 */ }
  onBusy(true);

  const r = await deleteAccount(fetchFn, got.session.access_token);
  if (!r.ok) {
    onBusy(false);
    await dialogs.messageDialog({ title: T.failTitle, message: r.error });
    reload();
    return 'fail';
  }

  // 服务器已删：清本机（失败再试一次，审核 M6）
  let wiped = await wipeLocalLocked(store, { locks });
  if (!wiped) wiped = await wipeLocalLocked(store, { locks });
  if (!wiped) {
    try { await clearSession(store); } catch (e) { console.warn(`[delete-account] 清登录失败：${e && e.name ? e.name : '未知'}`); }
    await dialogs.messageDialog({ title: T.doneTitle, message: T.partialMessage });
    reload();
    return 'done';
  }
  try { storage?.removeItem(HIDE_KEY); } catch { /* 隐私模式等：不影响 */ }
  announce(); // 其他分页显示「需要重新载入」（审核 M5）
  await dialogs.messageDialog({ title: T.doneTitle, message: T.doneMessage });
  reload();
  return 'done';
}
