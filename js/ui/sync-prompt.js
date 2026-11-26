// 第一次上传前的提醒（用户决定 3）：「导出 CSV」不关窗（分享要在点击手势里），「开始同步」才认领。
// 按「以后再说」或 Esc → 'dismiss'（设置页会显示「尚未开始同步 · 开始」）。
import { choiceDialog } from './dialogs.js';
import { createExporter } from './export-csv.js';

export const SYNC_PROMPT_TEXT = Object.freeze({
  title: '上传这台设备的账本？',
  message: (n) => `这台设备的 ${n} 笔账会上传到你的账号。建议先导出 CSV 备份。`,
  exportLabel: '导出 CSV',
  startLabel: '开始同步',
  laterLabel: '以后再说',
});

/** 回 'start' | 'dismiss'。 */
export async function askSyncStart(store, n) {
  const T = SYNC_PROMPT_TEXT;
  const exportCsv = createExporter(store); // Telegram 不能分享时提示去浏览器导出（开始同步后记录就会在那里；3c-2 有意保留按钮）
  const v = await choiceDialog({
    title: T.title,
    message: T.message(n),
    // 直排三个（iOS 习惯：主要动作最上、取消最下）；焦点放「以后再说」（上传撤不回，Enter 不该直接开始）
    buttons: [
      { label: T.startLabel, bold: true, value: 'start' },
      { label: T.exportLabel, keepOpen: true, onClick: exportCsv },
      { label: T.laterLabel, value: 'dismiss', focus: true },
    ],
  });
  return v === 'start' ? 'start' : 'dismiss';
}
