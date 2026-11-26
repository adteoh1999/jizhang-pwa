// 「Telegram 已解除连接」（3b-9）：服务器说这个 Telegram 已经没连着本机账本的账号（在 PWA 解除、删号、站主移除）。
// 先停同步与即时连线 → 问：先关闭（焦点，下次打开会再问，Q13）／清除（红）。
// Telegram 里暂不提供「导出 CSV」（用户 2026-11-26 决定：按了可能没反应，以为导出了再清除会丢记录；3c 再处理），
// 有没上传的就请用户先关闭。
// 清除 = wipe（清本机账本＋隐藏金额设定）＋通知其他分页 → reload（会回到登录页）。清除失败 → 说明后回到对话框。
// 依赖全部注入（不碰 DOM），方便测试。

export const TG_GONE_TEXT = Object.freeze({
  title: 'Telegram 已解除连接',
  message: '这台设备上的账本会清除。',
  unsynced: (n) => (n > 0 ? `还有 ${n} 笔没上传，清除后会消失。` : '还有改动没上传，清除后会消失。'),
  keepHint: '要保留没上传的记录，请先按「先关闭」。',
  clearLabel: '清除',
  closeLabel: '先关闭',
  failTitle: '清除失败，请再试一次',
  failMessage: '这台设备的账本还在。',
});

/**
 * deps：store, stop(), wipe() → boolean, reload(), choice(opts), message(opts), closeMiniApp(), announceReset(),
 *   onClosed()（按了先关闭之后画挡画面：close() 没作用时不是白屏）
 * 回 'cleared' | 'closed'。
 */
export async function runTgGone(deps) {
  const T = TG_GONE_TEXT;
  try { deps.stop(); } catch { /* 已停 */ }
  for (;;) {
    const owner = (await deps.store.getMeta('owner_user_id')) || null;
    const info = deps.store.unsyncedInfo({ all: !owner });
    // 安全选项在左（同 confirmDialog）
    const buttons = [
      { label: T.closeLabel, value: 'close', focus: true },
      { label: T.clearLabel, destructive: true, value: 'clear' },
    ];
    const v = await deps.choice({ title: T.title, message: T.message + (info.any ? T.unsynced(info.txCount) + T.keepHint : ''), buttons });
    if (v !== 'clear') {
      try { if (deps.onClosed) deps.onClosed(); } catch { /* 忽略 */ }
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
