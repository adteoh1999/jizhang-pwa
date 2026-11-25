// 设置页（iOS inset grouped 列表）：账号（2d：邮箱、登出）、管理（2f-3：只有站主看得到的邀请码管理）、
// 分类、数据（导出 / 导入 CSV）、关于、删除账号（2f，最下面）。绑定是第 3 阶段的事，这里不放占位。
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
import { runDeleteAccount, dangerRows, busyRowHandler } from './delete-account.js';
import { refreshOwnerFlag, readOwnerFlag } from '../owner-check.js';
import { openInvitesPage } from './invites-page.js';

/**
 * 设置页「同步」列的文字（纯函数）。回 {text, action}；action：可点时做什么（'relogin' | 'errors' | 'start' | 'reload'），不能点为 null。
 * showSyncing：这一轮已超过约 1 秒才显示「同步中…」（HIG：短于一两秒不显示进行中），否则照目前笔数显示。
 * 优先顺序：登录过期 → 账号已更换 → 属于另一个账号 → 尚未开始 → 无法同步 → 其余。「N 笔」只数账目。
 */
export function syncLabel(st, { showSyncing = false } = {}) {
  const n = st.txPending;
  if (st.state === 'signed-out') return { text: '登录已过期 · 重新登录', action: 'relogin' };
  if (st.state === 'stale') return { text: '账号已更换 · 重新整理', action: 'reload' };
  if (st.state === 'other-owner') return { text: '账本属于另一个账号', action: null };
  if (st.state === 'unclaimed') return { text: '尚未开始同步 · 开始', action: 'start' };
  if (st.state === 'stopped') return { text: '已停止', action: null };
  if (st.errors > 0) return { text: st.txErrors > 0 ? `有 ${st.txErrors} 笔无法同步` : '有分类无法同步', action: 'errors' };
  if (st.state === 'offline') return { text: n > 0 ? `离线 · 待上传 ${n} 笔` : '离线', action: null };
  if (st.state === 'error') return { text: n > 0 ? `稍后重试 · 待上传 ${n} 笔` : '稍后重试', action: null };
  if (st.state === 'syncing' && showSyncing) return { text: '同步中…', action: null };
  return { text: n > 0 ? `待上传 ${n} 笔` : (st.pending > 0 ? '待上传' : '已同步'), action: null };
}

/**
 * 同步列文字的计时：同步中未满 1 秒保留上一个文字（避免「稍后重试」闪动），满 1 秒才「同步中…」；离开同步中就清计时。
 * onSlow：满 1 秒时叫（画面重画）。
 */
export function createSyncLabeler({ setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), onSlow = () => {} } = {}) {
  let timer = null;
  let show = false;
  let last = null;
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    label(st) {
      if (st.state === 'syncing') {
        if (show) return syncLabel(st, { showSyncing: true });
        if (timer === null) timer = setTimer(() => { timer = null; show = true; onSlow(); }, 1000);
        return last || syncLabel(st);
      }
      stop();
      show = false;
      last = syncLabel(st);
      return last;
    },
    dispose: stop,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const DIAG_RESULT = { ok: '成功', halt: '暂停', skip: '另一个分页在同步' };
/**
 * 设置页「同步」下方的诊断行（纯函数，2e-3）：上次检查时间与结果、拉回笔数、进行中、即时连线。
 * diag：sync.diagnostics()；realtime：'off' | 'connecting' | 'live' | null。时间用本地 HH:MM:SS。
 */
export function syncDiagText(diag, opts = {}) {
  return syncDiagParts(diag, opts).join(' · ');
}

/** 诊断行的各段（画面上每段整组换行；读屏用逗号停顿）。 */
export function syncDiagParts(diag, { now = Date.now(), realtime = null } = {}) {
  const parts = [];
  if (diag.lastRunAt === null) parts.push('还没检查');
  else {
    const d = new Date(diag.lastRunAt);
    parts.push(`上次检查 ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`);
    parts.push(diag.lastResult === 'fail' ? `失败（连续 ${diag.failures} 次）` : (DIAG_RESULT[diag.lastResult] || '—'));
    if (diag.lastAdopted > 0) parts.push(`收到 ${diag.lastAdopted} 笔`);
  }
  if (diag.runningSince !== null && now - diag.runningSince >= 10_000) parts.push(`进行中 ${Math.round((now - diag.runningSince) / 1000)} 秒`);
  if (realtime === 'live') parts.push('即时连线');
  else if (realtime === 'connecting') parts.push('连线中');
  return parts;
}

const ERROR_LIST_MAX = 8;
/** 「无法同步」明细（纯函数）：账目「日期 · 分类 · 金额」（已删除标出）、分类「分类 · 名称」；最多列 8 行。 */
export function syncErrorMessage({ txs = [], cats = [] }, categoryById) {
  const all = [
    ...txs.map((t) => {
      const c = categoryById(t.category_id);
      const amount = formatRM(t.kind === 'income' ? t.amount_minor : -t.amount_minor);
      return `${t.occurred_on} · ${c ? c.name : '未分类'} · ${amount}${t.deleted ? '（已删除）' : ''}`;
    }),
    ...cats.map((c) => `分类 · ${c.name}`),
  ];
  const lines = all.slice(0, ERROR_LIST_MAX);
  if (all.length > ERROR_LIST_MAX) lines.push(`还有 ${all.length - ERROR_LIST_MAX} 项`);
  return `这些记录上传不了，仍保留在这台设备上。修改后会重新上传。\n\n${lines.join('\n')}`;
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

/** 「管理」区的列（纯函数）：只有站主有「邀请码管理」（快取只决定显不显示，权限由服务器判断）。 */
export function adminRows(isOwner) {
  return isOwner ? [{ kind: 'invites', label: '邀请码管理' }] : [];
}

/**
 * opts.session：目前登录的 session（没有就不显示账号区）。
 * opts.sync：同步引擎（status / subscribe / stop）；opts.onStartSync()：设置页按「开始」（认领，回 promise）。
 */
export function mountSettings(root, store, { session = null, sync = null, onStartSync = () => {}, realtime = null } = {}) {
  let seq = 0;
  // title 空字串：不放标题（iOS 设置里单独一列的红字区就是这样），也不设 aria-labelledby
  const section = (title, rows, footer) => {
    const id = `settings-sec-${++seq}`;
    return h('section', { class: 'settings-section', 'aria-labelledby': title ? id : null },
      title ? h('h2', { class: 'settings-header', id }, title) : null,
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
  const reloadAfter = async (title) => {
    // 同步已停：提示后重新整理，让它重新开始（账本与登录都还在）
    await messageDialog({ title, message: '请再试一次。' });
    location.reload();
  };
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
    } catch (e) {
      console.warn(`[settings] 登出出错：${e && e.name ? e.name : '未知'}`);
    }
    if (!done) {
      signingOut = false;
      signOutLabel.textContent = '登出';
      if (signOutBtn) signOutBtn.disabled = false;
      await reloadAfter('登出失败');
    }
  }

  // ---- 同步列：没有动作时是普通列，有动作时才是按钮（VoiceOver 不会念成「调暗的按钮」）----
  const syncInfoDetail = h('span', { class: 'inset-row-detail' });
  const syncBtnDetail = h('span', { class: 'inset-row-detail' });
  const syncInfo = h('div', { class: 'inset-row sync-row' }, h('span', { class: 'inset-row-label' }, '同步'), syncInfoDetail);
  const syncBtn = h('button', { type: 'button', class: 'inset-row sync-row', hidden: true, on: { click: () => onSyncAction() } },
    h('span', { class: 'inset-row-label' }, '同步'), syncBtnDetail,
    h('span', { class: 'inset-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16)));
  let syncAction = null;
  const labeler = createSyncLabeler({ onSlow: () => renderSync() });
  // 诊断行：设置页账号区下方的小字（不朗读、不可点）；显示时每 5 秒更新「进行中」
  const syncDiag = h('span', { class: 'sync-diag' });
  const renderDiag = () => {
    if (!sync) return;
    const parts = syncDiagParts(sync.diagnostics(), { now: Date.now(), realtime: realtime ? realtime.state() : null });
    // 每段整组换行（不会断在「即时／连线」中间）；「·」读屏不念，改用看不见的逗号停顿
    syncDiag.replaceChildren(...parts.flatMap((p, i) => [
      ...(i ? [h('span', { 'aria-hidden': 'true' }, ' · '), h('span', { class: 'sr-only' }, '，')] : []),
      h('span', { class: 'nowrap' }, p),
    ]));
  };
  if (sync) {
    setInterval(() => { if (syncDiag.isConnected && !document.hidden) renderDiag(); }, 5000);
    if (realtime) realtime.subscribe(renderDiag);
  }
  function renderSync() {
    if (!sync) return;
    renderDiag();
    const { text, action } = labeler.label(sync.status());
    syncInfoDetail.textContent = text; // 不自动朗读（状态变化不打断读屏）
    syncBtnDetail.textContent = text;
    syncAction = action;
    syncInfo.hidden = !!action;
    syncBtn.hidden = !action;
  }
  let acting = false;
  async function onSyncAction() {
    if (acting) return;
    acting = true;
    try {
      if (syncAction === 'relogin') await onRelogin();
      else if (syncAction === 'reload') location.reload();
      else if (syncAction === 'start') await onStartSync();
      else if (syncAction === 'errors') {
        await messageDialog({ title: '无法同步', message: syncErrorMessage(store.syncErrorRows(), (id) => store.categoryById(id)) });
      }
    } finally {
      acting = false;
    }
  }
  async function onRelogin() {
    // 离线时清了登录也收不到验证码，会卡在登录页：先挡下
    if (navigator.onLine === false) {
      await messageDialog({ title: '请连上网络后再试', message: '重新登录需要网络和邮箱验证码。' });
      return;
    }
    const ok = await confirmDialog({
      title: '要重新登录吗？', message: '需要网络和邮箱验证码。这台设备上的账本会保留。', confirmLabel: '重新登录',
    });
    if (!ok) return;
    if (sync) sync.stop();
    try {
      await forgetSession(store);
    } catch (e) {
      console.warn(`[settings] 清登录失败：${e && e.name ? e.name : '未知'}`);
      await reloadAfter('没能重新登录');
      return;
    }
    location.reload();
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
      if (r.kind === 'sync') return sync ? [syncInfo, syncBtn] : null;
      signOutBtn = h('button', { type: 'button', class: 'inset-row is-destructive', on: { click: onSignOut } }, signOutLabel);
      return signOutBtn;
    }).flat().filter(Boolean);
    return rows.length ? section('账号', rows, sync ? syncDiag : null) : null;
  };

  // ---------- 删除账号（最下面、红字；HIG：在 App 里提供清楚的删除入口）----------
  const dangerSection = () => {
    const rows = dangerRows(session).map((r) => {
      const label = h('span', { class: 'inset-row-label' }, r.label);
      // 流程内部的意外已在 runDeleteAccount 复位并重新整理；这里的 catch 只是保险
      const btn = h('button', {
        type: 'button', class: 'inset-row is-destructive',
        on: {
          click: () => runDeleteAccount({
            store, sync, realtime,
            userId: session.user_id, // 审核 1：只删挂载这个设置页时的账号
            fetchFn: (url, init) => fetch(url, init),
            reload: () => location.reload(),
            onBusy: busyRowHandler({ btn, label, idleText: r.label }),
          }).catch((e) => {
            console.warn(`[settings] 删除账号出错：${e && e.name ? e.name : '未知'}`);
            location.reload();
          }),
        },
      }, label);
      return btn;
    });
    return rows.length ? section('', rows) : null;
  };

  // ---------- 管理（只有站主）：先藏起来，读到快取才显示；enter()（启动、回前景、打开设置页）时需要才问服务器 ----------
  const adminSection = section('管理', adminRows(true).map((r) => buttonRow(r.label, () => openInvitesPage(store, {
    userId: session.user_id,
    onOwnerChanged: () => { renderAdmin().catch(() => {}); },
    // 那一列被藏起来了（服务器说没有权限）：关页时焦点放到设置页大标题
    restoreFocus: () => {
      const t = root.closest('.screen') && root.closest('.screen').querySelector('.large-title');
      if (t) { t.tabIndex = -1; t.focus({ preventScroll: true }); }
    },
  }), { chevron: true })));
  adminSection.hidden = true;
  const renderAdmin = async () => {
    adminSection.hidden = !(session && adminRows(await readOwnerFlag(store, session.user_id)).length);
  };
  const enter = () => {
    if (!session) return Promise.resolve();
    return refreshOwnerFlag(store, { fetchFn: (url, init) => fetch(url, init), userId: session.user_id })
      .then(renderAdmin)
      .catch((e) => console.warn(`[settings] 站主判断出错：${e && e.name ? e.name : '未知'}`));
  };
  renderAdmin().catch((e) => console.warn(`[settings] 读站主快取出错：${e && e.name ? e.name : '未知'}`));

  root.replaceChildren(
    ...[accountSection()].filter(Boolean),
    adminSection,
    section('分类', [
      buttonRow('管理分类', () => openCategoriesPage(store, { from: 'settings' }), { chevron: true }),
    ]),
    section('数据', [
      buttonRow('导出 CSV', onExport, { action: true, chevron: true }),
      buttonRow('导入 CSV', () => fileInput.click(), { action: true, chevron: true }),
    ]),
    section('关于', [versionRow], '账本先存在这台设备，登录后会在背景同步到你的账号。'),
    ...[dangerSection()].filter(Boolean),
    fileInput,
  );
  return { enter };
}
