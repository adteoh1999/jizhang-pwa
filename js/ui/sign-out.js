// 设置页「登出」（2f Task 10，spec §8.6）：登出会清掉这台设备的账本（用户决定 1）。
// 都传上去了 → 一个确认框；还有没同步的 → 先同步／导出 CSV／仍要登出（红）／取消（焦点）。
// 登出中挡住整个画面「正在登出…」（最长约 7 秒）。
// 「先同步」：还没归属先认领（审核 S12；按了就当同意、不再问），再跑一轮同步，之后重新判断（审核 S13：失败说明原因）。
// 登录已过期、只剩无法同步、账本属于别的账号、离线时不提供「先同步」，改在内文说明。
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
  offlineNote: '现在离线，联网才能再登录。', // 13 字：320 宽大字级放得下一行（2f 截图复核 B）
  unsyncedMessage: '登出会遗失这些记录。',
  syncLabel: '先同步',
  exportLabel: '导出 CSV',
  forceLabel: '仍要登出',
  cancelLabel: '取消',
  reasonSignedOut: '登录已过期，现在无法同步。\n账号若已删除，可直接登出。', // 一句一行，窄屏大字级不落单（2f 截图⑥）
  reasonErrors: '这些记录上传不了，可以先导出 CSV 保存。',
  reasonOther: '这本账属于另一个账号，无法同步到这个账号。',
  reasonNoSync: '现在无法同步，请重新整理后再试。',
  reasonOffline: '现在离线，无法同步，也要连上网络才能再登录。',
  syncingLabel: '正在同步…',
  needNetTitle: '请连上网络后再同步',
  needNetMessage: '连上网络后再按「先同步」。',
  syncFailTitle: '没能同步',
  syncFailMessage: '暂时连不上服务器，请稍后再试。',
  syncSkipMessage: '另一个分页正在同步，请稍后再试。',
  syncHaltMessage: '现在无法同步，请稍后再试。',
  claimFailTitle: '没能开始同步',
  claimFailMessage: '请稍后再试一次。',
  syncLateTitle: '还在同步',
  syncLateMessage: '同步还没完成，请稍后再试。',
  switchedTitle: '账号已更换',
  switchedMessage: '请重新整理后再试。',
  failTitle: '登出失败',
  failMessage: '请再试一次。',
});
const T = SIGNOUT_TEXT;

/** 有没同步时的标题（纯函数）：有账目写笔数，只有分类改动写「还有改动没同步」。 */
export const unsyncedTitle = (txCount) => (txCount > 0 ? `还有 ${txCount} 笔没同步` : '还有改动没同步');

// 不能「先同步」的原因（null＝可以）
function noSyncReason({ sync, owner, userId, store, online, T = SIGNOUT_TEXT }) {
  if (!sync) return T.reasonNoSync;
  const st = sync.status().state;
  if (st === 'signed-out') return T.reasonSignedOut;
  if (owner && owner !== userId) return T.reasonOther;
  if (st === 'stopped' || st === 'stale') return T.reasonNoSync;
  if (owner && store.syncCounts().pending === 0) return T.reasonErrors; // 只剩无法同步的
  if (!online) return T.reasonOffline; // 离线：按了也同步不了，直接说明（小事）
  return null;
}

const withBreak = (text) => (text ? `\n${text}` : ''); // 对话框内文是 pre-line，\n 会换行

let running = false;

/**
 * 跑一次登出流程。回 'done' | 'cancel' | 'fail'。正在跑时再叫直接回 'cancel'。
 * deps：store、userId（设置页挂载时的账号）、sync、realtime、onStartSync（认领，回 claimState 结果）、
 * fetchFn、isOnline、reload、onBusy(bool)；测试另可注入 dialogs、storage、announce、exportCsv、locks、block。
 * 3b-10（Mini App「解除连接」用）：text 覆盖 SIGNOUT_TEXT 的部分键；beforeWipe() → boolean 在挡住画面之后、清除之前跑，
 * false（或丢错）→ 解除遮罩、回 'fail'、不清、不 reload。不给时行为不变。
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
  syncWaitMs = 25_000, // 「正在同步…」最多挡这么久（审核 S-6：一轮上限 120 秒，不能挡那么久）
  text = null,
  beforeWipe = null,
  exportable = true, // false：不提供「导出 CSV」（Telegram 里暂不支援，3c 再处理）
}) {
  const T = text ? { ...SIGNOUT_TEXT, ...text } : SIGNOUT_TEXT;
  for (;;) {
    // 别的分页已换成另一个账号：不能替那个账号登出、清掉它的账本
    const cur = await loadSession(store);
    if (!cur) { reload(); return 'done'; } // 别的分页已登出：重新整理就会到登录页
    if (cur.user_id !== userId) {
      await dialogs.messageDialog({ title: T.switchedTitle, message: T.switchedMessage });
      reload();
      return 'fail';
    }
    // 先从资料库重读（审核 S-3：别的分页刚记的账，快取可能还没更新）；账本已被换掉 → 同账号已更换
    if ((await store.reloadFromDb()) === 'ledger-changed') {
      await dialogs.messageDialog({ title: T.switchedTitle, message: T.switchedMessage });
      reload();
      return 'fail';
    }
    const owner = (await store.getMeta('owner_user_id')) || null;
    const info = store.unsyncedInfo({ all: !owner }); // 还没归属（从没同步过）：整本都算（审核 S12）
    const offlineNote = isOnline() ? '' : T.offlineNote;
    if (!info.any) {
      const ok = await dialogs.confirmDialog({
        title: T.plainTitle, message: T.plainMessage + withBreak(offlineNote), confirmLabel: T.confirmLabel, destructive: true,
      });
      if (!ok) return 'cancel';
      break;
    }
    const reason = noSyncReason({ sync, owner, userId, store, online: !offlineNote, T });
    const answer = await dialogs.choiceDialog({
      title: unsyncedTitle(info.txCount),
      // 原因另起一行（2f 截图⑥：接在同一段句尾会落单）；离线那句已含「要连上网络才能再登录」，不再重复
      message: T.unsyncedMessage + withBreak(reason) + withBreak(reason === T.reasonOffline ? '' : offlineNote),
      // 直排四个（用户决定）；焦点放「取消」（登出会丢资料，Enter 不该往下走）
      buttons: [
        ...(reason ? [] : [{ label: T.syncLabel, value: 'sync' }]),
        ...(exportable ? [{ label: T.exportLabel, keepOpen: true, onClick: exportCsv }] : []),
        { label: T.forceLabel, value: 'signout', destructive: true },
        { label: T.cancelLabel, value: 'cancel', focus: true },
      ],
    });
    if (answer === 'signout') break;
    if (answer !== 'sync') return 'cancel';
    await syncFirst({ sync, owner, onStartSync, isOnline, dialogs, block, syncWaitMs });
    // 不管结果如何都回到上面重新判断（传完了就变成一个确认框）
  }

  // 等锁最多 5 秒＋通知服务器最多 2 秒：先挡住整个画面（审核 S-5，同删号；免得这段时间记的账被清掉）
  onBusy(true);
  let unblock = block(T.busyLabel);
  const release = () => { if (unblock) { const u = unblock; unblock = null; try { u(); } catch { /* 忽略 */ } } };
  if (beforeWipe) {
    let go = false;
    try { go = (await beforeWipe()) === true; } catch (e) { console.warn(`[sign-out] 清除前步骤出错：${e && e.name ? e.name : '未知'}`); }
    if (!go) { release(); onBusy(false); return 'fail'; }
  }
  let done = false;
  try {
    done = await signOut(store, () => {
      try { storage?.removeItem(HIDE_KEY); } catch { /* 隐私模式等：不影响 */ }
      try { announce(); } catch { /* 通知其他分页失败：这一页照常登出 */ } // 其他分页显示「需要重新载入」（审核 M5）
      reload();
    }, {
      fetchFn, locks, isOnline, userId, // userId：锁里清除前再核对（审核 S-1）
      stopSync: () => {
        try { if (sync) sync.stop(); } catch { /* 停不了也照样登出 */ }
        try { if (realtime) realtime.stop(); } catch { /* 同上 */ }
      },
    });
  } catch (e) {
    console.warn(`[sign-out] 出错：${e && e.name ? e.name : '未知'}`);
  }
  if (done === true) return 'done';
  if (done === 'gone') { reload(); return 'done'; } // 对话框开着时别的分页登出了
  release();
  onBusy(false);
  if (done === 'switched') {
    await dialogs.messageDialog({ title: T.switchedTitle, message: T.switchedMessage });
    reload();
    return 'fail';
  }
  // 同步已停：说明后重新整理，让它重新开始（账本与登录都还在）
  await dialogs.messageDialog({ title: T.failTitle, message: T.failMessage });
  reload();
  return 'fail';
}

// 「先同步」：离线先挡；还没归属先认领（不再问，用户决定）；同步中显示「正在同步…」（最多 syncWaitMs）
async function syncFirst({ sync, owner, onStartSync, isOnline, dialogs, block, syncWaitMs }) {
  if (!isOnline()) {
    await dialogs.messageDialog({ title: T.needNetTitle, message: T.needNetMessage });
    return;
  }
  if (!owner) {
    let st;
    try { st = await onStartSync({ consented: true }); } catch { st = 'error'; } // 按「先同步」＝已同意，不再弹认领提示
    if (st === 'error') { // 认领失败：这里说明完才回到选择（复核 3）
      await dialogs.messageDialog({ title: T.claimFailTitle, message: T.claimFailMessage });
      return;
    }
    if (st !== 'mine') return; // 账本已属于别的账号等：回到选择，内文会说明
  }
  const unblock = block(T.syncingLabel);
  let res;
  let timer = null;
  try {
    // 到时限就不等了（同步照样在背景跑完）
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), syncWaitMs); });
    res = await Promise.race([sync.syncNow(), late]);
  } catch (e) {
    console.warn(`[sign-out] 同步出错：${e && e.name ? e.name : '未知'}`);
    res = 'fail';
  } finally {
    clearTimeout(timer);
    try { unblock(); } catch { /* 忽略 */ }
  }
  if (res === 'ok') return;
  if (res === 'late') {
    await dialogs.messageDialog({ title: T.syncLateTitle, message: T.syncLateMessage });
    return;
  }
  const message = res === 'skip' ? T.syncSkipMessage : res === 'halt' ? T.syncHaltMessage : T.syncFailMessage;
  await dialogs.messageDialog({ title: T.syncFailTitle, message });
}
