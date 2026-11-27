// 设置页「删除账号和全部数据」（2f，spec §8.5）。两次确认：第一次可先导出 CSV，第二次要输入「删除」。
// 规格写 action sheet，这里刻意用 alert（choiceDialog）：「先导出 CSV」要在点击当下叫分享（keepOpen），action sheet 做不到。
// 流程：离线先挡 → 两次确认 → 「正在删除…」并挡住整个画面（2f-2 审核 4）→ 拿可用的 session（拿不到就说明、不动资料；失效时重新整理）
//      → 核对还是设置页挂载时的账号（审核 1）→ 停同步与 Realtime → 叫 delete-account（超时自动再叫一次，审核 3；
//      401 刷新 token 再叫一次，审核 8）→ 成功：清本机（拿锁）、清隐藏金额、通知其他分页、告知已删除、重新整理（回登录页）
//      → 失败：说明原因、重新整理（同步重新开始，本机资料不动）。
import { choiceDialog, confirmDialog, messageDialog, busyOverlay } from './dialogs.js';
import { createExporter } from './export-csv.js';
import { HIDE_KEY } from './home.js';
import { getValidSession, wipeLocalLocked, forgetSession, clearSession, LOCK_WAIT_MS } from '../auth.js';
import { deleteAccount } from '../admin-api.js';
import { announceLedgerReset } from '../ledger-channel.js';

export const DELETE_TEXT = Object.freeze({
  rowLabel: '删除账号和全部数据',
  busyLabel: '正在删除…',
  offlineTitle: '需要网络才能删除账号',
  offlineMessage: '请连上网络后再试。',
  firstTitle: '删除账号和全部数据？',
  firstMessage: '会永久删除你在这台设备和云端的所有记录、分类、关键词和设置，无法复原。',
  exportLabel: '先导出 CSV',
  continueLabel: '继续删除',
  cancelLabel: '取消',
  secondTitle: '确定永久删除？',
  secondMessage: '请输入「删除」以确认。',
  requireText: '删除',
  confirmLabel: '永久删除',
  reloginTitle: '请重新登录后再试',
  reloginMessage: '登录已过期。请先在上面「同步」那一列重新登录，再删除账号。账号若已删除，直接登出即可。',
  retryTitle: '暂时连不上',
  retryMessage: '请稍后再试。',
  switchedTitle: '账号已更换',
  switchedMessage: '请重新整理后再试。',
  failTitle: '没能删除账号',
  timeoutTitle: '没收到回应',
  timeoutMessage: '没收到服务器的回应，账号可能已经删除，请重新整理后再试一次。',
  doneTitle: '账号已删除',
  doneMessage: '你的账号和全部数据都已删除。',
  partialMessage: '这台设备上的资料还没清掉，下次登录时会清除。',
  partialStuckMessage: '但这台设备的资料没清掉，请重新整理后再登出一次。',
});
const T = DELETE_TEXT;

/** 设置页最下面那一区的列（纯函数）：有登录才显示。 */
export function dangerRows(session) {
  return session ? [{ kind: 'delete-account', label: T.rowLabel }] : [];
}

/**
 * 删除／登出那一列的忙碌显示（审核 9）：改文字（busyText）、aria-disabled（不用 disabled；连按由 running 旗标挡）。
 * 朗读交给「正在删除…」遮罩（焦点移过去会念，方案 B），这里不另外念。回 onBusy(bool)。
 */
export function busyRowHandler({ btn, label, idleText, busyText = T.busyLabel }) {
  return (busy) => {
    label.textContent = busy ? busyText : idleText;
    if (busy) btn.setAttribute('aria-disabled', 'true');
    else btn.removeAttribute('aria-disabled');
  };
}

let running = false;

/**
 * 跑一次删除账号流程。回 'done' | 'cancel' | 'fail'。正在跑时再叫直接回 'cancel'。
 * deps：store、userId（设置页挂载时的账号，必填）、sync、realtime、fetchFn、isOnline、reload、onBusy(bool)；
 * 测试另可注入 dialogs、storage、announce、exportCsv、locks、block（挡画面，回放开的函数）、deleteTimeoutMs、lockWaitMs。
 * 中途意外出错：复位、重新整理（同步可能已停）、回 'fail'。
 */
export async function runDeleteAccount(deps) {
  if (running) return 'cancel';
  running = true;
  const ui = { busy: false, unblock: null };
  try {
    return await flow(deps, ui);
  } catch (e) {
    console.warn(`[delete-account] 出错：${e && e.name ? e.name : '未知'}`);
    release(deps.onBusy, ui);
    try { deps.reload(); } catch { /* 没办法了 */ }
    return 'fail';
  } finally {
    running = false;
  }
}

// 复位：放开画面、列恢复原样（重复叫没关系）。删成功时 keepBusy：马上要重新整理，列不用变回原样
function release(onBusy = () => {}, ui, { keepBusy = false } = {}) {
  if (ui.unblock) { const u = ui.unblock; ui.unblock = null; try { u(); } catch { /* 忽略 */ } }
  if (ui.busy && !keepBusy) { ui.busy = false; onBusy(false); }
}

async function flow({
  store, userId, sync = null, realtime = null, fetchFn, reload,
  isOnline = () => globalThis.navigator ? globalThis.navigator.onLine !== false : true,
  onBusy = () => {},
  dialogs = { choiceDialog, confirmDialog, messageDialog },
  storage = globalThis.localStorage,
  announce = announceLedgerReset,
  exportCsv = createExporter(store), // Telegram 不能分享时提示去浏览器导出（删号前可以先取消去导出云端资料；3c-2 有意保留按钮）
  locks,
  block = () => busyOverlay(T.busyLabel),
  deleteTimeoutMs,
  lockWaitMs = LOCK_WAIT_MS, // 等 jizhang-auth 锁的上限：画面已挡住，别的分页卡住锁也不能一直等（复审 1）
}, ui) {
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

  // 按下后立刻有回馈、整个画面不可操作（审核 4：防途中按「登出」、导入 CSV）
  ui.busy = true;
  onBusy(true);
  ui.unblock = block();
  const fail = async (title, message) => {
    release(onBusy, ui);
    await dialogs.messageDialog({ title, message });
    return 'fail';
  };

  // 先拿 session（审核 S14）：拿不到就什么都不动，同步照常。失效时重新整理（复审小事：同步那一列才一定会出现「重新登录」）
  const got = await getValidSession(store, fetchFn, { locks, waitMs: lockWaitMs });
  if (!got.session) {
    if (!got.invalid) return fail(T.retryTitle, T.retryMessage);
    await fail(T.reloginTitle, T.reloginMessage);
    reload();
    return 'fail';
  }
  // 审核 1：别的分页已换成另一个账号 → 不能删掉那个账号
  // 主屏幕 App 没有重新整理按钮：说明后替用户重新整理（复核小事）
  if (!userId || got.session.user_id !== userId) {
    await fail(T.switchedTitle, T.switchedMessage);
    reload();
    return 'fail';
  }
  try { if (sync) sync.stop(); } catch { /* 停不了也照样往下 */ }
  try { if (realtime) realtime.stop(); } catch { /* 同上 */ }

  const call = (token) => deleteAccount(fetchFn, token, deleteTimeoutMs === undefined ? {} : { timeoutMs: deleteTimeoutMs });
  let token = got.session.access_token;
  let r = await call(token);
  // 审核 3：超时 → 服务器可能已经删了；再叫一次（账号不在了服务器也回 200）
  if (!r.ok && r.timeout) r = await call(token);
  // 审核 8：401 → 刷新 token 再叫一次（不在锁里，不会重入）。刷新连不上 → 暂时连不上；换了账号 → 账号已更换；
  // 刷新失效或仍 401 → 请重新登录（复审 2）。同步已停，失败一律重新整理
  let why = null;
  if (!r.ok && r.status === 401) {
    const again = await getValidSession(store, fetchFn, { locks, failedToken: token, waitMs: lockWaitMs });
    if (!again.session) why = again.invalid ? 'relogin' : 'retry';
    else if (again.session.user_id !== userId) why = 'switched';
    else {
      token = again.session.access_token;
      r = await call(token);
      if (!r.ok && r.timeout) r = await call(token);
    }
  }
  if (!r.ok) {
    if (why === 'retry') await fail(T.retryTitle, T.retryMessage);
    else if (why === 'switched') await fail(T.switchedTitle, T.switchedMessage);
    else if (r.timeout) await fail(T.timeoutTitle, T.timeoutMessage);
    else if (r.status === 401) await fail(T.reloginTitle, T.reloginMessage);
    else await fail(T.failTitle, r.error);
    reload();
    return 'fail';
  }

  // 服务器已删：清本机（失败再试一次，审核 M6）
  let wiped = await wipeLocalLocked(store, { locks, waitMs: lockWaitMs });
  if (!wiped) wiped = await wipeLocalLocked(store, { locks, waitMs: lockWaitMs });
  if (!wiped) {
    // 至少清掉 session（拿锁，审核 2）：成功 → reload 会到登录页，下次登录一定是别的账号 id，会走换账号清除
    // 等锁超时 → 不用锁直接清（照 wipeLocalLocked 的后备，复审 5）
    let cleared = true;
    try {
      await forgetSession(store, { locks, waitMs: lockWaitMs });
    } catch (e) {
      console.warn(`[delete-account] 清登录失败：${e && e.name ? e.name : '未知'}`);
      cleared = false;
      if (e && e.name === 'LockTimeout') {
        try { await clearSession(store); cleared = true; } catch { /* 仍失败：显示要重新整理再登出 */ }
      }
    }
    release(onBusy, ui, { keepBusy: true });
    await dialogs.messageDialog({ title: T.doneTitle, message: cleared ? T.partialMessage : T.partialStuckMessage });
    reload();
    return 'done';
  }
  try { storage?.removeItem(HIDE_KEY); } catch { /* 隐私模式等：不影响 */ }
  try { announce(); } catch { /* 通知其他分页失败：这一页照常告知已删除（复审小事） */ } // 其他分页显示「需要重新载入」（审核 M5）
  release(onBusy, ui, { keepBusy: true });
  await dialogs.messageDialog({ title: T.doneTitle, message: T.doneMessage });
  reload();
  return 'done';
}
