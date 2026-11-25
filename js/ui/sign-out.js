// 设置页「登出」（2f Task 10，spec §8.6）：登出会清掉这台设备的账本（用户决定 1）。
// 都传上去了 → 一个确认框；还有没同步的 → 先同步／导出 CSV／仍要登出（红）／取消（焦点）。
// 「先同步」：还没归属先认领（审核 S12），再跑一轮同步，之后重新判断（审核 S13：失败说明原因）。
// 登录已过期、只剩无法同步、账本属于别的账号时不提供「先同步」，改在内文说明。
import { choiceDialog, confirmDialog, messageDialog, busyOverlay } from './dialogs.js';
import { createExporter } from './export-csv.js';
import { HIDE_KEY } from './home.js';
import { signOut, loadSession } from '../auth.js';
import { announceLedgerReset } from '../ledger-channel.js';

export const SIGNOUT_TEXT = Object.freeze({
  rowLabel: '登出',
  busyLabel: '正在登出…',
  plainTitle: '要登出吗？',
  plainMessage: '这台设备上的账本会清除，下次登录会从云端拉回。',
  confirmLabel: '登出',
  offlineNote: '现在离线，要连上网络才能再登录。',
  unsyncedMessage: '登出会遗失这些记录。',
  syncLabel: '先同步',
  exportLabel: '导出 CSV',
  forceLabel: '仍要登出',
  cancelLabel: '取消',
  reasonSignedOut: '登录已过期，现在无法同步。账号若已删除，直接登出即可。',
  reasonErrors: '这些记录上传不了，可以先导出 CSV 保存。',
  reasonOther: '这本账属于另一个账号，无法同步到这个账号。',
  reasonNoSync: '现在无法同步，请重新整理后再试。',
  syncingLabel: '正在同步…',
  needNetTitle: '请连上网络后再同步',
  needNetMessage: '连上网络后再按「先同步」。',
  syncFailTitle: '没能同步',
  syncFailMessage: '暂时连不上服务器，请稍后再试。',
  syncSkipMessage: '另一个分页正在同步，请稍后再试。',
  syncHaltMessage: '现在无法同步，请稍后再试。',
  switchedTitle: '账号已更换',
  switchedMessage: '请重新整理后再试。',
  failTitle: '登出失败',
  failMessage: '请再试一次。',
});
const T = SIGNOUT_TEXT;

/** 有没同步时的标题（纯函数）：有账目写笔数，只有分类改动写「还有改动没同步」。 */
export const unsyncedTitle = (txCount) => (txCount > 0 ? `还有 ${txCount} 笔没同步` : '还有改动没同步');

// 不能「先同步」的原因（null＝可以）
function noSyncReason({ sync, owner, userId, store }) {
  if (!sync) return T.reasonNoSync;
  const st = sync.status().state;
  if (st === 'signed-out') return T.reasonSignedOut;
  if (owner && owner !== userId) return T.reasonOther;
  if (st === 'stopped' || st === 'stale') return T.reasonNoSync;
  if (owner && store.syncCounts().pending === 0) return T.reasonErrors; // 只剩无法同步的
  return null;
}

let running = false;

/**
 * 跑一次登出流程。回 'done' | 'cancel' | 'fail'。正在跑时再叫直接回 'cancel'。
 * deps：store、userId（设置页挂载时的账号）、sync、realtime、onStartSync（认领，回 claimState 结果）、
 * fetchFn、isOnline、reload、onBusy(bool)；测试另可注入 dialogs、storage、announce、exportCsv、locks、block。
 */
export async function runSignOut(deps) {
  if (running) return 'cancel';
  running = true;
  try {
    return await flow(deps);
  } finally {
    running = false;
  }
}

async function flow({
  store, userId, sync = null, realtime = null, onStartSync = async () => 'unclaimed', fetchFn, reload,
  isOnline = () => globalThis.navigator ? globalThis.navigator.onLine !== false : true,
  onBusy = () => {},
  dialogs = { choiceDialog, confirmDialog, messageDialog },
  storage = globalThis.localStorage,
  announce = announceLedgerReset,
  exportCsv = createExporter(store),
  locks,
  block = (text) => busyOverlay(text),
}) {
  for (;;) {
    // 别的分页已换成另一个账号：不能替那个账号登出、清掉它的账本
    const cur = await loadSession(store);
    if (!cur || cur.user_id !== userId) {
      await dialogs.messageDialog({ title: T.switchedTitle, message: T.switchedMessage });
      reload();
      return 'fail';
    }
    const owner = (await store.getMeta('owner_user_id')) || null;
    const info = store.unsyncedInfo({ all: !owner }); // 还没归属（从没同步过）：整本都算（审核 S12）
    const offlineNote = isOnline() ? '' : T.offlineNote;
    if (!info.any) {
      const ok = await dialogs.confirmDialog({
        title: T.plainTitle, message: T.plainMessage + offlineNote, confirmLabel: T.confirmLabel, destructive: true,
      });
      if (!ok) return 'cancel';
      break;
    }
    const reason = noSyncReason({ sync, owner, userId, store });
    const answer = await dialogs.choiceDialog({
      title: unsyncedTitle(info.txCount),
      message: T.unsyncedMessage + (reason || '') + offlineNote,
      // 直排四个（用户决定）；焦点放「取消」（登出会丢资料，Enter 不该往下走）
      buttons: [
        ...(reason ? [] : [{ label: T.syncLabel, value: 'sync' }]),
        { label: T.exportLabel, keepOpen: true, onClick: exportCsv },
        { label: T.forceLabel, value: 'signout', destructive: true },
        { label: T.cancelLabel, value: 'cancel', focus: true },
      ],
    });
    if (answer === 'signout') break;
    if (answer !== 'sync') return 'cancel';
    await syncFirst({ sync, owner, onStartSync, isOnline, dialogs, block });
    // 不管结果如何都回到上面重新判断（传完了就变成一个确认框）
  }

  onBusy(true);
  let done = false;
  try {
    done = await signOut(store, () => {
      try { storage?.removeItem(HIDE_KEY); } catch { /* 隐私模式等：不影响 */ }
      try { announce(); } catch { /* 通知其他分页失败：这一页照常登出 */ } // 其他分页显示「需要重新载入」（审核 M5）
      reload();
    }, {
      fetchFn, locks, isOnline,
      stopSync: () => {
        try { if (sync) sync.stop(); } catch { /* 停不了也照样登出 */ }
        try { if (realtime) realtime.stop(); } catch { /* 同上 */ }
      },
    });
  } catch (e) {
    console.warn(`[sign-out] 出错：${e && e.name ? e.name : '未知'}`);
  }
  if (done) return 'done';
  onBusy(false);
  // 同步已停：说明后重新整理，让它重新开始（账本与登录都还在）
  await dialogs.messageDialog({ title: T.failTitle, message: T.failMessage });
  reload();
  return 'fail';
}

// 「先同步」：离线先挡；还没归属先认领（认领可能先问一次，问完才挡画面）；同步中显示「正在同步…」
async function syncFirst({ sync, owner, onStartSync, isOnline, dialogs, block }) {
  if (!isOnline()) {
    await dialogs.messageDialog({ title: T.needNetTitle, message: T.needNetMessage });
    return;
  }
  if (!owner) {
    let st;
    try { st = await onStartSync(); } catch { st = 'error'; }
    if (st !== 'mine') return; // 关掉认领提示、或认领失败（认领自己会提示）
  }
  const unblock = block(T.syncingLabel);
  let res;
  try {
    res = await sync.syncNow();
  } catch (e) {
    console.warn(`[sign-out] 同步出错：${e && e.name ? e.name : '未知'}`);
    res = 'fail';
  } finally {
    try { unblock(); } catch { /* 忽略 */ }
  }
  if (res === 'ok') return;
  const message = res === 'skip' ? T.syncSkipMessage : res === 'halt' ? T.syncHaltMessage : T.syncFailMessage;
  await dialogs.messageDialog({ title: T.syncFailTitle, message });
}
