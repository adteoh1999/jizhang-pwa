// 「Telegram 已解除连接」（3b-9）：服务器说这个 Telegram 已经没连着本机账本的账号（在 PWA 解除、删号、站主移除）。
// 先停同步与即时连线 → 问：先关闭（焦点，下次打开会再问，Q13）／清除（红）。
// 3f（审核 M-1）：有没上传的账、而且这台设备能分享 CSV（exportable）时，多一颗「导出 CSV」（不关对话框）；
// 有没上传的改动时按「清除」先再问一次（用户 2026-11-28：分享面板被取消不会有提示，怕以为存好了）。
// 清除 = wipe（清本机账本＋隐藏金额设定）＋通知其他分页 → reload（会回到登录页）。清除失败 → 说明后回到对话框。
// 依赖全部注入（不碰 DOM），方便测试。

import { LOGIN_TEXT } from './login.js';

export const TG_GONE_TEXT = Object.freeze({
  title: 'Telegram 已解除连接',
  message: '这台设备上的账本会清除。',
  unsynced: (n) => (n > 0 ? `还有 ${n} 笔没上传，清除后会消失。` : '还有改动没上传，清除后会消失。'),
  keepHint: '要保留没上传的记录，请先按「先关闭」。',
  keepHintExport: '想留着的话，可以先导出 CSV，或按「先关闭」。',
  exportLabel: '导出 CSV',
  clearLabel: '清除',
  closeLabel: '先关闭',
  failTitle: '清除失败，请再试一次',
  failMessage: '这台设备的账本还在。',
});

// 分享失败时的提示（createExporter 的 tgFallback）：这个对话框没有「先同步」，叫人按「先关闭」（3f 审核）
export const TG_GONE_EXPORT_FAIL = Object.freeze({ title: '这里导出不了', message: '想留着就先按「先关闭」。' });

/**
 * deps：store, stop(), wipe() → boolean, reload(), choice(opts), message(opts), closeMiniApp(), announceReset(),
 *   onClosed()（按了先关闭之后画挡画面：close() 没作用时不是白屏）
 *   3f 选填：exportable（预设 false）、exportCsv()、confirm(opts) → boolean（有没上传时清除前再问）
 * 回 'cleared' | 'closed'。
 */
export async function runTgGone(deps) {
  const T = TG_GONE_TEXT;
  try { deps.stop(); } catch { /* 已停 */ }
  for (;;) {
    const owner = (await deps.store.getMeta('owner_user_id')) || null;
    const info = deps.store.unsyncedInfo({ all: !owner });
    const canExport = deps.exportable === true && info.txCount > 0;
    // 两颗：安全选项在左（同 confirmDialog）；三颗变直排：照登出等对话框，导出 → 红字 → 安全选项在最下（焦点）
    const buttons = canExport ? [
      { label: T.exportLabel, keepOpen: true, onClick: deps.exportCsv },
      { label: T.clearLabel, destructive: true, value: 'clear' },
      { label: T.closeLabel, value: 'close', focus: true },
    ] : [
      { label: T.closeLabel, value: 'close', focus: true },
      { label: T.clearLabel, destructive: true, value: 'clear' },
    ];
    const hint = canExport ? T.keepHintExport : T.keepHint;
    const v = await deps.choice({ title: T.title, message: T.message + (info.any ? T.unsynced(info.txCount) + hint : ''), buttons });
    if (v !== 'clear') {
      try { if (deps.onClosed) deps.onClosed(); } catch { /* 忽略 */ }
      deps.closeMiniApp();
      return 'closed';
    }
    // 有没上传的改动：再问一次（沿用换账号的句子）；取消 → 回到对话框
    if (info.any && deps.confirm) {
      const sure = await deps.confirm({
        title: LOGIN_TEXT.clearTitle, message: LOGIN_TEXT.clearMessage, confirmLabel: LOGIN_TEXT.clearConfirm, destructive: true,
      });
      if (!sure) continue;
    }
    if (await deps.wipe()) {
      try { deps.announceReset(); } catch { /* 忽略 */ }
      deps.reload();
      return 'cleared';
    }
    await deps.message({ title: T.failTitle, message: T.failMessage });
  }
}
