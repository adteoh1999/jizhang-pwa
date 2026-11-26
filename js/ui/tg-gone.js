// 「Telegram 已解除连接」（3b-9）：服务器说这个 Telegram 已经没连着本机账本的账号（在 PWA 解除、删号、站主移除）。
// 先停同步与即时连线 → 问：清除（红）／先关闭（焦点，下次打开会再问，Q13）；有没上传的多「导出 CSV」。
// 清除 = wipe（清本机账本＋隐藏金额设定）＋通知其他分页 → reload（会回到登录页）。清除失败 → 说明后回到对话框。
// 依赖全部注入（不碰 DOM），方便测试。

export const TG_GONE_TEXT = Object.freeze({
  title: 'Telegram 已解除连接',
  message: '这台设备上的账本会清除。',
  unsynced: (n) => (n > 0 ? `还有 ${n} 笔没上传，清除后会消失。` : '还有改动没上传，清除后会消失。'),
  exportLabel: '导出 CSV',
  clearLabel: '清除',
  closeLabel: '先关闭',
  failTitle: '清除失败，请再试一次',
  failMessage: '这台设备的账本还在。',
});

/**
 * deps：store, stop(), wipe() → boolean, reload(), choice(opts), message(opts), exportCsv(), closeMiniApp(), announceReset()
 * 回 'cleared' | 'closed'。
 */
export async function runTgGone(deps) {
  const T = TG_GONE_TEXT;
  try { deps.stop(); } catch { /* 已停 */ }
  for (;;) {
    const owner = (await deps.store.getMeta('owner_user_id')) || null;
    const info = deps.store.unsyncedInfo({ all: !owner });
    const buttons = [];
    if (info.any) buttons.push({ label: T.exportLabel, keepOpen: true, onClick: () => deps.exportCsv() });
    buttons.push({ label: T.clearLabel, destructive: true, value: 'clear' });
    buttons.push({ label: T.closeLabel, value: 'close', focus: true });
    const v = await deps.choice({ title: T.title, message: T.message + (info.any ? T.unsynced(info.txCount) : ''), buttons });
    if (v !== 'clear') {
      deps.closeMiniApp();
      return 'closed';
    }
    if (await deps.wipe()) {
      try { deps.announceReset(); } catch { /* 忽略 */ }
      deps.reload();
      return 'cleared';
    }
    await deps.message({ title: T.failTitle, message: T.failMessage });
  }
}
