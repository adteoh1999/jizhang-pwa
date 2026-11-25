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
import { signOut, forgetSession } from '../auth.js';
import { formatRM } from '../money.js';
import { createExporter } from './export-csv.js';

/**
 * 设置页「同步」列的文字（纯函数）。回 {text, action}；action：可点时做什么（'relogin' | 'errors' | 'start' | 'reload'），不能点为 null。
 * showSyncing：这一轮已超过约 1 秒才显示「同步中…」（HIG：短于一两秒不显示进行中），否则照目前笔数显示。
 * 「N 笔」只数账目（分类不算笔）。
 */
export function syncLabel(st, { showSyncing = false } = {}) {
  const n = st.txPending;
  const waiting = n > 0 ? `待上传 ${n} 笔` : (st.pending > 0 ? '待上传' : '');
  if (st.state === 'signed-out') return { text: '登录已过期 · 重新登录', action: 'relogin' };
  if (st.errors > 0) return { text: `有 ${st.txErrors || st.errors} 笔无法同步`, action: 'errors' };
  if (st.state === 'stale') return { text: '账号已更换 · 重新整理', action: 'reload' };
  if (st.state === 'other-owner') return { text: '账本属于另一个账号', action: null };
  if (st.state === 'unclaimed') return { text: '尚未开始同步 · 开始', action: 'start' };
  if (st.state === 'offline') return { text: n > 0 ? `离线 · 待上传 ${n} 笔` : '离线', action: null };
  if (st.state === 'error') return { text: n > 0 ? `稍后重试 · 待上传 ${n} 笔` : '稍后重试', action: null };
  if (st.state === 'syncing' && showSyncing) return { text: '同步中…', action: null };
  return { text: waiting || '已同步', action: null };
}

/** 账号区要显示的列（纯函数）：有 session → 邮箱、同步、登出；没有 → 不显示账号区。 */
export function accountRows(session) {
  if (!session) return [];
  return [
    { kind: 'email', label: '邮箱', detail: session.email || '' },
    { kind: 'sync', label: '同步' },
    { kind: 'signout', label: '登出' },
  ];
}

const ERROR_LIST_MAX = 8;
/** 「无法同步」明细（纯函数）：日期 · 分类 · 金额，一行一笔；最多列 8 笔。 */
export function syncErrorMessage(rows, categoryById) {
  const lines = rows.slice(0, ERROR_LIST_MAX).map((t) => {
    const c = categoryById(t.category_id);
    const amount = formatRM(t.kind === 'income' ? t.amount_minor : -t.amount_minor);
    return `${t.occurred_on} · ${c ? c.name : '未分类'} · ${amount}`;
  });
  if (rows.length > ERROR_LIST_MAX) lines.push(`还有 ${rows.length - ERROR_LIST_MAX} 笔`);
  return `这些记录上传不了，仍保留在这台设备上。修改这笔后会重新上传。\n\n${lines.join('\n')}`;
}

/**
 * opts.session：目前登录的 session（没有就不显示账号区）。
 * opts.sync：同步引擎（status / subscribe / stop）；opts.onStartSync()：设置页按「开始」（认领）。
 */
export function mountSettings(root, store, { session = null, sync = null, onStartSync = () => {} } = {}) {
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
  const signOutLabel = h('span', { class: 'inset-row-label' }, '登出');
  let signOutBtn = null;
  async function onSignOut() {
    if (signingOut) return;
    const ok = await confirmDialog({
      title: '要登出吗？', message: '这台设备上的账本会保留。', confirmLabel: '登出', destructive: true,
    });
    if (!ok) return;
    signingOut = true;
    // 通知服务器最多等 2 秒：先给即时反馈（HIG）
    signOutLabel.textContent = '正在登出…';
    if (signOutBtn) signOutBtn.disabled = true;
    let done = false;
    try {
      done = await signOut(store, () => location.reload(), {
        fetchFn: (url, init) => fetch(url, init),
        stopSync: () => { if (sync) sync.stop(); },
      });
    } finally {
      if (!done) {
        signingOut = false;
        signOutLabel.textContent = '登出';
        if (signOutBtn) signOutBtn.disabled = false;
      }
    }
    if (!done) {
      // 同步已停：重新整理让它重新开始（账本与登录都还在）
      await messageDialog({ title: '登出失败', message: '请再试一次。' });
      location.reload();
    }
  }

  // ---- 同步列 ----
  const syncDetail = h('span', { class: 'inset-row-detail' });
  const syncChevron = h('span', { class: 'inset-row-chevron', 'aria-hidden': 'true', hidden: true }, icon('chevron-right', 16));
  const syncRow = h('button', { type: 'button', class: 'inset-row', disabled: true, on: { click: () => onSyncAction() } },
    h('span', { class: 'inset-row-label' }, '同步'), syncDetail, syncChevron);
  let syncAction = null;
  let showSyncing = false;
  let slowTimer = null;
  function renderSync() {
    if (!sync) return;
    const st = sync.status();
    if (st.state === 'syncing') {
      if (slowTimer === null && !showSyncing) slowTimer = setTimeout(() => { slowTimer = null; showSyncing = true; renderSync(); }, 1000);
    } else {
      if (slowTimer !== null) { clearTimeout(slowTimer); slowTimer = null; }
      showSyncing = false;
    }
    const { text, action } = syncLabel(st, { showSyncing });
    syncDetail.textContent = text; // 不自动朗读（状态变化不打断读屏）
    syncAction = action;
    syncRow.disabled = !action;
    syncChevron.hidden = !action;
  }
  async function onSyncAction() {
    if (syncAction === 'relogin') {
      if (sync) sync.stop();
      try { await forgetSession(store); } catch (e) { console.warn(`[settings] 清登录失败：${e && e.name ? e.name : '未知'}`); }
      location.reload();
    } else if (syncAction === 'reload') {
      location.reload();
    } else if (syncAction === 'start') {
      onStartSync();
    } else if (syncAction === 'errors') {
      await messageDialog({ title: '无法同步', message: syncErrorMessage(store.syncErrorRows(), (id) => store.categoryById(id)) });
    }
  }
  if (sync) {
    sync.subscribe(renderSync);
    store.subscribe(renderSync); // 用户记账 / 删除：待上传笔数要跟着变
    renderSync();
  }

  const accountSection = () => {
    const rows = accountRows(session).map((r) => {
      if (r.kind === 'email') {
        return h('div', { class: 'inset-row' },
          h('span', { class: 'inset-row-label' }, r.label),
          h('span', { class: 'inset-row-detail account-email' }, r.detail));
      }
      if (r.kind === 'sync') return sync ? syncRow : null;
      signOutBtn = h('button', { type: 'button', class: 'inset-row is-destructive', on: { click: onSignOut } }, signOutLabel);
      return signOutBtn;
    }).filter(Boolean);
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
    section('关于', [versionRow], '账本先存在这台设备，登录后会在背景同步到你的账号。'),
    fileInput,
  );
}
