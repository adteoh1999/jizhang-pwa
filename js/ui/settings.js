// 设置页（iOS inset grouped 列表）：分类、数据（导出 / 导入 CSV）、关于。
// 账号、绑定、邀请码、删除账号是第 2、3 阶段的事，这里不放占位。
// 注意：导出时 navigator.share 要在点击事件里同步呼叫（之前不能 await），否则会失去使用者手势。
import { h } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, messageDialog } from './dialogs.js';
import { showToast } from './toast.js';
import { openCategoriesPage } from './categories-page.js';
import { todayLocal } from '../dates.js';
import { APP_VERSION } from '../version.js';
import { onUpdateAvailable, applyUpdate } from '../update.js';

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

export function mountSettings(root, store) {
  let seq = 0;
  const section = (title, rows, footer) => {
    const id = `settings-sec-${++seq}`;
    return h('section', { class: 'settings-section', 'aria-labelledby': id },
      h('h2', { class: 'settings-header', id }, title),
      h('div', { class: 'inset-group' }, rows),
      footer ? h('p', { class: 'settings-footer' }, footer) : null);
  };
  // chevron：推入子画面 / 可点动作的尾随箭头；action：ink 色动作列
  const buttonRow = (label, onClick, { chevron = false, action = false } = {}) => h('button', {
    type: 'button', class: `inset-row${action ? ' is-action' : ''}`, on: { click: onClick },
  },
  h('span', { class: 'inset-row-label' }, label),
  chevron ? h('span', { class: 'inset-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16)) : null);

  // ---------- 导出 ----------
  let shareSeq = 0; // 每次分享一个编号，旧分享迟到的 finally 不会清掉新的
  let sharing = false; // 分享选单开着时再按一次「导出 CSV」不重复呼叫 navigator.share
  function onExport() {
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
  }

  // ---------- 导入 ----------
  const fileInput = h('input', {
    type: 'file', accept: '.csv,text/csv', hidden: true, tabindex: '-1', 'aria-hidden': 'true',
    'data-import-input': '',
  });
  let importing = false;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 同一个档案可以再选一次
    if (!file || importing) return;
    importing = true;
    importFile(file).catch((e) => console.error(e)).finally(() => { importing = false; });
  });

  async function importFile(file) {
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      console.warn(e);
      await messageDialog({ title: '无法读取档案', message: '请再试一次。' });
      return;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      await messageDialog({
        title: '无法读取档案',
        message: '这个档案不是 UTF-8 格式，请在 Excel 另存为「CSV UTF-8」后再试',
      });
      return;
    }
    let preview;
    try {
      preview = store.previewImport(text);
    } catch (e) {
      // csv.js 的格式错误讯息都是中文「CSV 格式不对：…」；其他意外错误不直接显示
      const known = e instanceof Error && e.message.startsWith('CSV');
      if (!known) console.error(e);
      await messageDialog({ title: '无法导入', message: known ? e.message : '档案内容无法辨识。' });
      return;
    }
    const { plan, imported, skipped, newCategoryCount } = preview;
    if (imported === 0 && newCategoryCount === 0) {
      await messageDialog({
        title: '没有可导入的记录',
        message: skipped > 0
          ? `略过 ${skipped} 笔：已有相同或较新的记录，或内容不完整。`
          : '这个档案里没有记录。',
      });
      return;
    }
    const ok = await confirmDialog({
      title: '导入 CSV',
      message: `将导入 ${imported} 笔、新建 ${newCategoryCount} 个分类、略过 ${skipped} 笔`,
      confirmLabel: '导入',
    });
    if (!ok) return;
    try {
      await store.applyImport(plan);
    } catch (e) {
      console.error(e);
      await messageDialog({ title: '导入失败', message: '资料没有变更，请稍后再试一次。' });
      return;
    }
    // 对话框已关闭才显示（浮层下的 toast 会被设为 inert）
    showToast(`已导入 ${imported} 笔，略过 ${skipped} 笔`);
  }

  // ---------- 版面 ----------
  const versionRow = h('div', { class: 'inset-row' },
    h('span', { class: 'inset-row-label' }, '版本'),
    h('span', { class: 'inset-row-detail' }, APP_VERSION));
  // 有新版本等待时，详情改成可点的「有新版本 · 更新」
  onUpdateAvailable(() => {
    const btn = h('button', {
      type: 'button', class: 'inset-row-detail update-action pressable', on: { click: applyUpdate },
    }, '有新版本 · 更新');
    versionRow.querySelector('.inset-row-detail').replaceWith(btn);
  });

  root.replaceChildren(
    section('分类', [
      buttonRow('管理分类', () => openCategoriesPage(store, { from: 'settings' }), { chevron: true }),
    ]),
    section('数据', [
      buttonRow('导出 CSV', onExport, { action: true, chevron: true }),
      buttonRow('导入 CSV', () => fileInput.click(), { action: true, chevron: true }),
    ]),
    section('关于', [versionRow], '数据只存在这台设备。'),
    fileInput,
  );
}
