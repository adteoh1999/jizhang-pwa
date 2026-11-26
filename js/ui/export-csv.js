// 导出 CSV（设置页与第一次同步提醒共用）。
// 注意：navigator.share 要在点击事件里同步呼叫（之前不能 await），否则 iOS 会失去使用者手势。
// Telegram 里（3c-2，用户 2026-11-26 决定）：先试分享；不能分享或分享失败 → 提示用浏览器导出，绝不走下载
// （Telegram 内建视窗的 <a download> 不可靠）。PWA 照旧：分享不行就下载。
import { h } from './dom.js';
import { messageDialog } from './dialogs.js';
import { todayLocal } from '../dates.js';
import { tgActive } from '../tg-chrome.js';

export const TG_EXPORT_TEXT = {
  title: '这里无法导出',
  message: '请用浏览器打开 jizhang.adteoh.com，登录后到「设置 › 导出 CSV」。还没同步完的记录，要等同步完成才会在那里。',
};
// 会清掉本机资料的对话框用这两句：那里的记录还没上传，浏览器里导出不会有它们（3c-2 审核必须改 1）；
// 各自给做得到的下一步（复审建议 1）：换账号 → 跟 switchMessageNoExport 一致；解除连接 → 回上一步按「先同步」
export const TG_EXPORT_SWITCH_TEXT = {
  title: '这里无法导出',
  message: '没上传的记录只在这台设备上。要保留，请取消后用原来的账号登录、等它上传完。',
};
export const TG_EXPORT_SIGNOUT_TEXT = {
  title: '这里无法导出',
  message: '没上传的记录只在这台设备上。能上传的话，请按「先同步」，等上传完成再继续。',
};
const SHARE_STUCK_MS = 30_000; // 分享面板一直没回应：超过这么久再按，就当上一轮已结束

/** 这台设备能不能用分享面板分享 CSV 档（Telegram 里决定对话框要不要放「先导出」）。不会丢错。 */
export function canShareCsv({ nav = globalThis.navigator } = {}) {
  try {
    const probe = { files: [new File([''], 'jizhang.csv', { type: 'text/csv' })] };
    return !!(nav && typeof nav.canShare === 'function' && nav.canShare(probe));
  } catch {
    return false;
  }
}

/** 导出档名：jizhang-YYYYMMDD.csv（当地日期）。 */
export function exportFileName(now = new Date()) {
  return `jizhang-${todayLocal(now).replaceAll('-', '')}.csv`;
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // 给浏览器（尤其 iOS）时间开始下载再释放
}

/**
 * 回一个「导出」函数（在点击事件里直接呼叫）。分享选单开着时再按一次不重复呼叫 navigator.share。
 * 测试可注入 nav、doc、save（下载）、notify（提示对话框）、inTelegram。
 */
export function createExporter(store, {
  nav = globalThis.navigator, doc = globalThis.document, save = download, notify = messageDialog, inTelegram = tgActive,
  tgFallback = TG_EXPORT_TEXT, now = Date.now,
} = {}) {
  let shareSeq = 0; // 每次分享一个编号，旧分享迟到的 finally 不会清掉新的
  let sharing = false;
  let sharingSince = 0;
  return function exportCsv() {
    // 某些内建视窗的分享 promise 可能永远不回来：超过 30 秒就不再挡（审核建议 4）
    if (sharing && now() - sharingSince < SHARE_STUCK_MS) return;
    if (store.transactions().length === 0) {
      notify({ title: '没有可导出的记录' });
      return;
    }
    const tg = inTelegram();
    const fallback = tg ? () => notify(tgFallback) : (f) => save(f);
    const file = new File([store.exportCSV()], exportFileName(), { type: 'text/csv' }); // exportCSV 已含 BOM
    const data = { files: [file] }; // canShare 与 share 用同一个物件
    let canShare = false;
    try {
      canShare = !!(nav && nav.canShare && nav.canShare(data));
    } catch { /* 部分浏览器对 files 会 throw → 当作不支援 */ }
    if (!canShare) { fallback(file); return; }
    sharing = true;
    sharingSince = now();
    const myId = ++shareSeq;
    const clear = () => {
      doc.removeEventListener('visibilitychange', onVisible);
      if (myId === shareSeq) sharing = false;
    };
    // 只有 app 从背景回到前景才会触发（iOS 分享选单本身不改变 visibility）
    const onVisible = () => { if (doc.visibilityState === 'visible' && now() - sharingSince > 1000) clear(); };
    doc.addEventListener('visibilitychange', onVisible);
    try {
      nav.share(data).catch((e) => {
        if (e && e.name === 'AbortError') return; // 使用者在分享选单按取消，不算错误
        fallback(file);
      }).finally(clear);
    } catch {
      clear(); // 同步 throw → 改用下载（Telegram：提示）
      fallback(file);
    }
  };
}
