// 设置页（iOS inset grouped 列表）：账号（2d：邮箱、登出）、分类、数据（导出 / 导入 CSV）、关于。
// 绑定、邀请码、删除账号是 2f、第 3 阶段的事，这里不放占位。
// 导出在 export-csv.js（提醒对话框也用）。
import { h } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, messageDialog } from './dialogs.js';
import { showToast } from './toast.js';
import { openCategoriesPage } from './categories-page.js';
import { APP_VERSION } from '../version.js';
import { onUpdateAvailable, applyUpdate } from '../update.js';
import { signOut } from '../auth.js';
import { createExporter } from './export-csv.js';

/** 账号区要显示的列（纯函数）：有 session → 邮箱、登出；没有 → 不显示账号区。 */
export function accountRows(session) {
  if (!session) return [];
  return [
    { kind: 'email', label: '邮箱', detail: session.email || '' },
    { kind: 'signout', label: '登出' },
  ];
}

/** opts.session：目前登录的 session（没有就不显示账号区）。 */
export function mountSettings(root, store, { session = null } = {}) {
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
  const onExport = createExporter(store);

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

  // ---------- 账号 ----------
  let signingOut = false;
  async function onSignOut() {
    if (signingOut) return;
    const ok = await confirmDialog({
      title: '要登出吗？', message: '这台设备上的账本会保留。', confirmLabel: '登出', destructive: true,
    });
    if (!ok) return;
    signingOut = true;
    const done = await signOut(store, () => location.reload());
    if (!done) {
      signingOut = false;
      await messageDialog({ title: '登出失败', message: '请再试一次。' });
    }
  }
  const accountSection = () => {
    const rows = accountRows(session).map((r) => (r.kind === 'email'
      ? h('div', { class: 'inset-row' },
        h('span', { class: 'inset-row-label' }, r.label),
        h('span', { class: 'inset-row-detail account-email' }, r.detail))
      : h('button', { type: 'button', class: 'inset-row is-destructive', on: { click: onSignOut } },
        h('span', { class: 'inset-row-label' }, r.label))));
    return rows.length ? section('账号', rows) : null;
  };

  root.replaceChildren(
    ...[accountSection()].filter(Boolean),
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
