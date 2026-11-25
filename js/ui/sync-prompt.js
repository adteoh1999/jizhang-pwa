// 第一次上传前的提醒（用户决定 3）：「导出 CSV」不关窗（分享要在点击手势里），「开始同步」才认领。
// Esc 关掉 → 'dismiss'（设置页会显示「尚未开始同步 · 开始」）。
import { choiceDialog } from './dialogs.js';
import { createExporter } from './export-csv.js';

export const SYNC_PROMPT_TEXT = Object.freeze({
  title: '上传这台设备的账本？',
  message: (n) => `这台设备的 ${n} 笔账会上传到你的账号。建议先导出 CSV 备份。`,
  exportLabel: '导出 CSV',
  startLabel: '开始同步',
});

/** 回 'start' | 'dismiss'。 */
export async function askSyncStart(store, n) {
  const T = SYNC_PROMPT_TEXT;
  const exportCsv = createExporter(store);
  const v = await choiceDialog({
    title: T.title,
    message: T.message(n),
    buttons: [
      { label: T.exportLabel, keepOpen: true, onClick: exportCsv },
      { label: T.startLabel, bold: true, value: 'start' },
    ],
  });
  return v === 'start' ? 'start' : 'dismiss';
}
