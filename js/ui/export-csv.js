// 导出 CSV（设置页与第一次同步提醒共用）。
// 注意：navigator.share 要在点击事件里同步呼叫（之前不能 await），否则 iOS 会失去使用者手势。
import { h } from './dom.js';
import { messageDialog } from './dialogs.js';
import { todayLocal } from '../dates.js';

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

/** 回一个「导出」函数（在点击事件里直接呼叫）。分享选单开着时再按一次不重复呼叫 navigator.share。 */
export function createExporter(store) {
  let shareSeq = 0; // 每次分享一个编号，旧分享迟到的 finally 不会清掉新的
  let sharing = false;
  return function exportCsv() {
    if (sharing) return;
    if (store.transactions().length === 0) {
      messageDialog({ title: '没有可导出的记录' });
      return;
    }
    const file = new File([store.exportCSV()], exportFileName(), { type: 'text/csv' }); // exportCSV 已含 BOM
    const data = { files: [file] }; // canShare 与 share 用同一个物件
    let canShare = false;
    try {
      canShare = !!(navigator.canShare && navigator.canShare(data));
    } catch { /* 部分浏览器对 files 会 throw → 当作不支援 */ }
    if (!canShare) { download(file); return; }
    sharing = true;
    const startedAt = Date.now();
    const myId = ++shareSeq;
    const clear = () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (myId === shareSeq) sharing = false;
    };
    // 只有 app 从背景回到前景才会触发（iOS 分享选单本身不改变 visibility）
    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - startedAt > 1000) clear(); };
    document.addEventListener('visibilitychange', onVisible);
    try {
      navigator.share(data).catch((e) => {
        if (e && e.name === 'AbortError') return; // 使用者在分享选单按取消，不算错误
        download(file);
      }).finally(clear);
    } catch {
      clear(); // 同步 throw → 改用下载
      download(file);
    }
  };
}
