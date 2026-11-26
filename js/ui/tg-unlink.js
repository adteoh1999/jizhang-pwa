// 解除 Telegram 连接（3b-10）：
//   runTgUnlinkPwa：PWA 设置页的「解除 Telegram 连接」。这台设备不受影响；服务器会登出这个账号的其他设备（含 Telegram）。
//   runTgUnlinkMiniApp：Mini App 设置页的「解除连接」。用登出流程（runSignOut）：先请服务器解除，成功才清本机账本。
// 依赖可注入，方便测试。名字等文字一律当文字（对话框用 text node）。
import { confirmDialog, choiceDialog, messageDialog, busyOverlay } from './dialogs.js';
import { runSignOut } from './sign-out.js';
import { canShareCsv } from './export-csv.js';
import { getValidSession, logoutServer } from '../auth.js';
import { tgLink, tgLogin } from '../tg-api.js';

export const TG_UNLINK_TEXT = Object.freeze({
  pwaTitle: '解除 Telegram 连接？',
  pwaMessage: 'Telegram 里的记账会被登出。这个账号在其他设备（包括别的手机的 PWA）也会被登出，最晚 1 小时内生效。这台设备不受影响。',
  confirmLabel: '解除连接',
  busy: '正在解除连接…',
  needNetTitle: '需要网络才能解除连接',
  needNetMessage: '连上网络后再试一次。',
  reloginTitle: '请重新登录后再试',
  reloginMessage: '登录已过期，没办法解除连接。',
  retryTitle: '暂时无法完成，请稍后再试',
  retryMessage: '请确认网络后再试一次。',
  staleTitle: '请关掉后重新打开再试',
  staleMessage: '这次打开太久了，要重新从 @adjizhangbot 打开。',
  pwaFailTitle: '没能解除连接',
  doneToast: '已解除连接',
  partialTitle: '已解除连接，但没能登出其他设备',
  partialMessage: '其他设备上的 Telegram 记账可能还能用一阵子（最晚 1 小时）。',
  partialMiniMessage: '可以之后在 PWA 再解除一次。',
  retry: '再试一次',
  later: '稍后',
  failTitle: '没能解除连接，请稍后再试',
  // Mini App：沿用登出流程，换掉这几句
  miniTitle: '要解除连接吗？',
  miniMessage: '这台设备上的账本会清除。这个账号在其他设备（包括 iPhone 的 PWA）也会被登出，最晚 1 小时内生效。',
  miniForce: '仍要解除连接',
  // Mini App 没有「登出」：登出流程里提到登出／登录的句子都换掉
  mini: Object.freeze({
    unsyncedMessage: '解除连接会遗失这些记录。',
    offlineNote: '现在离线，联网才能解除连接。',
    reasonSignedOut: '登录已过期，现在无法同步。',
    reasonOffline: '现在离线，无法同步，也要连上网络才能解除连接。',
    reasonErrors: '这些记录上传不了。',
    failTitle: '没能解除连接',
  }),
});
const U = TG_UNLINK_TEXT;
const defaultOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true);
const fetchDefault = (url, init) => fetch(url, init);

/** 回 'done' | 'partial' | 'cancel' | 'fail'。 */
export async function runTgUnlinkPwa({
  store, userId, fetchFn = fetchDefault, isOnline = defaultOnline, toast = () => {},
  dialogs = { confirmDialog, choiceDialog, messageDialog },
  getSession = () => getValidSession(store, fetchFn),
  tgLink: link = (token, action) => tgLink(fetchFn, token, action),
  refreshStatus = async () => {},
  block = (text) => busyOverlay(text),
}) {
  const ok = await dialogs.confirmDialog({ title: U.pwaTitle, message: U.pwaMessage, confirmLabel: U.confirmLabel, destructive: true });
  if (!ok) return 'cancel';
  if (!isOnline()) {
    await dialogs.messageDialog({ title: U.needNetTitle, message: U.needNetMessage });
    return 'fail';
  }
  for (;;) {
    let r;
    const unblock = block(U.busy);
    try {
      const got = await getSession();
      if (got && got.retry) r = 'retry'; // 断网、等锁超时：不是登录过期
      else if (!got || !got.session || got.session.user_id !== userId) r = 'relogin';
      else r = await link(got.session.access_token, 'unlink');
    } finally {
      try { unblock(); } catch { /* 忽略 */ }
    }
    if (r === 'retry') {
      await dialogs.messageDialog({ title: U.retryTitle, message: U.retryMessage });
      return 'fail';
    }
    if (r === 'relogin') {
      await dialogs.messageDialog({ title: U.reloginTitle, message: U.reloginMessage });
      return 'fail';
    }
    if (!r.ok) {
      await dialogs.messageDialog({ title: U.pwaFailTitle, message: r.error });
      return 'fail';
    }
    try { await refreshStatus(); } catch { /* 状态列晚点再更新 */ }
    if (r.data && r.data.others === false) {
      const v = await dialogs.choiceDialog({
        title: U.partialTitle, message: U.partialMessage,
        buttons: [{ label: U.later, value: 'later' }, { label: U.retry, value: 'retry', bold: true }], // 安全选项在左
      });
      if (v === 'retry') continue; // unlink 可以重试：已解除的回 unlinked:false，但会再登出其他设备一次
      return 'partial';
    }
    toast(U.doneToast);
    return 'done';
  }
}

/**
 * Mini App 的「解除连接」：runSignOut 换文字＋beforeWipe（先请服务器解除，成功才清）。
 * deps：runSignOut 的 deps（store、userId、sync、realtime、onStartSync、fetchFn、reload、onBusy、dialogs…）＋
 *   env（initData）、getSession、tgLink(token, action)、tgLogin(initData)、logoutServer(session)（都可注入）。
 */
export function runTgUnlinkMiniApp(deps) {
  const {
    store, userId, env, fetchFn = fetchDefault,
    isOnline = defaultOnline,
    dialogs = { choiceDialog, confirmDialog, messageDialog },
    getSession = () => getValidSession(store, fetchFn),
    tgLink: link = (token, action) => tgLink(fetchFn, token, action),
    tgLogin: login = (initData) => tgLogin(fetchFn, initData, Date.now()),
    logoutServer: logout = (s) => { logoutServer(fetchFn, s.access_token).catch(() => {}); },
  } = deps;
  const discard = (s) => { try { logout(s); } catch { /* 尽力 */ } };

  const beforeWipe = async () => {
    if (!isOnline()) {
      await dialogs.messageDialog({ title: U.needNetTitle, message: U.needNetMessage });
      return false;
    }
    const fail = async () => { await dialogs.messageDialog({ title: U.failTitle, message: '' }); return false; };
    let token = null;
    let minted = null; // tg-login 换来的新 session：用完不管成败都作废（r2-M2-4）
    const got = await getSession();
    if (got && got.session) {
      if (got.session.user_id !== userId) return fail();
      token = got.session.access_token;
    } else {
      // token 失效：凭 initData 问 tg-login
      const l = await login(env.initData);
      if (l && l.ok && l.status === 'unlinked') return true; // 服务器已经没有这个连接：直接清本机
      if (l && l.ok && l.status === 'stale') { // 打开太久：稍后再试也不会好，要关掉重开
        await dialogs.messageDialog({ title: U.staleTitle, message: U.staleMessage });
        return false;
      }
      if (!(l && l.ok && l.status === 'linked' && l.session.user_id === userId)) {
        if (l && l.ok && l.session) discard(l.session);
        return fail();
      }
      minted = l.session;
      token = minted.access_token;
    }
    try {
      const r = await link(token, 'unlink');
      if (!r.ok) return fail();
      if (r.data && r.data.others === false) await dialogs.messageDialog({ title: U.partialTitle, message: U.partialMiniMessage });
      return true;
    } finally {
      if (minted) discard(minted);
    }
  };

  return runSignOut({
    ...deps, dialogs, isOnline,
    text: { ...U.mini, plainTitle: U.miniTitle, plainMessage: U.miniMessage, confirmLabel: U.confirmLabel, forceLabel: U.miniForce, busyLabel: U.busy },
    beforeWipe,
    exportable: canShareCsv(), // Telegram：能分享 CSV 才给「导出」（3c-2）
  });
}
