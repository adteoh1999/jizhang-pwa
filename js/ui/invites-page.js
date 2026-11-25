// 邀请码管理子画面（2f Task 8–9，只有站主看得到）：列表、新增（次数／有效期／备注）、生成后复制或分享。
// 跟服务器说话的部分（ownerCall、loadInvites、createInvite、copyInvite、shareInvite）不碰画面，测试直接叫；
// 画面照分类页的导航推入（右边滑入、左上「‹ 设置」）。真正的权限由服务器判断，这里只是显示。
import { h } from './dom.js';
import { icon } from './icons.js';
import { pushLayer } from './nav.js';
import { openSheet } from './sheet.js';
import { messageDialog, choiceDialog, confirmDialog, busyOverlay, trapFocus } from './dialogs.js';
import { optionSegmented, confirmDiscard } from './components.js';
import { announce } from './announce.js';
import { callInvites, DENIED_ERROR } from '../admin-api.js';
import { getValidSession } from '../auth.js';
import { OWNER_FLAG_KEY } from '../owner-check.js';
import {
  formatCode, spokenCode, inviteMeta, shareText, VALIDITY_OPTIONS, DEFAULT_DAYS, clampUses,
  USES_MIN, USES_MAX, NOTE_MAX, statusLabel, usesLabel, expiryLabel, dateLabelMY,
} from '../invite-format.js';

export const INVITE_TEXT = Object.freeze({
  title: '邀请码',
  back: '设置',
  loading: '正在载入…',
  offline: '需要网络才能管理邀请码',
  retry: '暂时连不上，请稍后再试',
  timeout: '没收到服务器的回应，请稍后再试',
  createTimeout: '没收到服务器的回应，邀请码可能已经生成。列表已重新载入，请先看一下再决定要不要再生成。',
  noReplyTitle: '没收到回应',
  generating: '正在生成…',
  denied: '没有权限',
  relogin: '登录已过期，请先在设置页「同步」那一列重新登录。',
  switched: '账号已更换，请重新整理。',
  generic: '暂时无法完成，请稍后再试',
  retryButton: '重试',
  reloadButton: '重新整理',
  empty: '还没有邀请码',
  add: '新增邀请码',
  footer: '邀请码有效、还有次数时，别人才能用它注册。已注册的人之后登录不需要邀请码。',
  newTitle: '新增邀请码',
  cancel: '取消',
  generate: '生成',
  usesLabel: '可用次数',
  fewer: '减少次数',
  more: '增加次数',
  validityLabel: '有效期',
  notePlaceholder: '备注（选填）',
  noteLabel: '备注',
  newFooter: `备注只有你看得到，最多 ${NOTE_MAX} 字。`,
  createFailTitle: '没能生成邀请码',
  resultTitle: '邀请码已生成',
  resultHint: '把邀请码给对方：在登录页输入邮箱和邀请码就能注册。',
  done: '完成',
  copy: '复制',
  copied: '已复制',
  copyFail: '请长按邀请码手动复制',
  share: '分享',
  shareFail: '没能打开分享，请改用复制。',
  // ---- 明细（Task 9）----
  detailBack: '邀请码',
  statusRow: '状态',
  usesRow: '使用次数',
  expiryRow: '有效期',
  noteRow: '备注',
  disable: '停用这个邀请码',
  enable: '重新启用',
  toggleFailTitle: '没能更新邀请码',
  usersHeader: '用这个码注册的人',
  usersEmpty: '还没有人用这个邀请码注册',
  usersFooter: '移除会永久删除对方的账号和全部数据。',
  deletedUser: '已删除的用户',
  unfinishedUser: '删除未完成的用户',
  pendingUser: '注册未完成',
  ownerTag: '站主',
  remove: '移除',
  removeTitle: '移除这个用户？',
  removeContinue: '继续',
  removeConfirmTitle: '确定永久删除？',
  removeConfirmMessage: '请输入「删除」以确认。',
  removeRequire: '删除',
  removeConfirmLabel: '永久删除',
  removing: '正在移除…',
  removed: '已移除',
  removeFailTitle: '没能移除这个用户',
  removeTimeoutTitle: '没收到回应',
  removeTimeout: '没收到服务器的回应，这个用户可能已经移除。列表已重新载入，请看一下。',
});
const T = INVITE_TEXT;

const defaultOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true);
const fail = (reason, message) => ({ ok: false, reason, message });

/**
 * 以站主身分叫 invites（每个动作共用）：离线先挡 → 拿可用的 session（必须是 userId）→ 叫 → 401 刷新一次再叫。
 * 回 {ok:true, data} 或 {ok:false, reason, message}；reason：offline（断网）| timeout | relogin | switched | denied | error。
 * 403「没有权限」→ 站主快取改成 false（设置页的入口会消失）；别的 403（例如「不能移除站主」）只是一般失败。不会 reject。
 * deps：store、fetchFn、userId、isOnline、now；测试可注入 getSession(failedToken)。
 */
export async function ownerCall(deps, action, args = {}) {
  const { store, fetchFn, userId, isOnline = defaultOnline, now = Date.now } = deps;
  const getSession = deps.getSession || ((failedToken) => getValidSession(store, fetchFn, { failedToken }));
  if (!isOnline()) return fail('offline', T.offline);
  let token = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const got = await getSession(token);
    if (got.invalid) return fail('relogin', T.relogin);
    if (!got.session) return fail('error', T.retry);
    if (got.session.user_id !== userId) return fail('switched', T.switched);
    token = got.session.access_token;
    const r = await callInvites(fetchFn, token, action, args);
    if (r.ok) return r;
    if (r.status === 401) continue;
    if (r.status === 0) return r.timeout ? fail('timeout', T.timeout) : fail('offline', T.offline);
    if (r.status === 403 && r.error === DENIED_ERROR) {
      try {
        await store.setMeta(OWNER_FLAG_KEY, { userId, value: false, checkedAt: now() });
      } catch (e) {
        console.warn(`[invites] 改站主快取失败：${e && e.name ? e.name : '未知'}`);
      }
      return fail('denied', T.denied);
    }
    return fail('error', r.error);
  }
  return fail('relogin', T.relogin);
}

/** 邀请码清单：{ok:true, invites} 或失败（同 ownerCall）。 */
export async function loadInvites(deps) {
  const r = await ownerCall(deps, 'list');
  if (!r.ok) return r;
  return Array.isArray(r.data.invites) ? { ok: true, invites: r.data.invites } : fail('error', T.generic);
}

const CODE_RE = /^[A-Z0-9]{8}$/;
/**
 * 新增一个码：次数夹到 1–20、天数不在选项里当 7、备注去空白截到 40 字（服务器也会再检查）。
 * days 为 null（永不过期）时一定送出 days 键（缺键服务器回 400，S3）。回 {ok:true, code} 或失败。
 */
export async function createInvite(deps, { maxUses, days, note }) {
  const okDays = VALIDITY_OPTIONS.some((o) => o.days === days) ? days : DEFAULT_DAYS;
  // 按字符截（服务器也按字符数）：不能把表情符号切成半个（2f-3 审核 9）
  const cleanNote = [...String(note ?? '').trim()].slice(0, NOTE_MAX).join('').trim();
  const r = await ownerCall(deps, 'create', { max_uses: clampUses(maxUses), days: okDays, note: cleanNote });
  if (!r.ok) return r;
  return typeof r.data.code === 'string' && CODE_RE.test(r.data.code) ? { ok: true, code: r.data.code } : fail('error', T.generic);
}

/** 复制带横线的码；成功 true（没有剪贴簿、被拒都是 false）。 */
export async function copyInvite(code, clipboard = globalThis.navigator && globalThis.navigator.clipboard) {
  try {
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    await clipboard.writeText(formatCode(code));
    return true;
  } catch {
    return false;
  }
}

export const canShare = (nav) => !!nav && typeof nav.share === 'function';

/**
 * 新增之后要做什么（纯函数，2f-3 审核 3）：成功 → 关表单、显示码；超时（服务器可能已经生成）→ 关表单、重载列表、说明；
 * 没有权限 → 关表单、重载（入口另外藏）；其他 → 表单留着、说明原因。
 */
export function createFollowUp(r) {
  if (r.ok) return { close: true, reload: false, showCode: true, message: null };
  if (r.reason === 'timeout') return { close: true, reload: true, showCode: false, message: T.createTimeout };
  if (r.reason === 'denied') return { close: true, reload: true, showCode: false, message: r.message };
  return { close: false, reload: false, showCode: false, message: r.message };
}

/**
 * 防重入、保证复位的执行器（2f-3 审核 6）：执行中再叫回 null；fn 丢错也会叫 onEnd，回通用失败。
 */
export function createGuardedRunner({ onStart = () => {}, onEnd = () => {} } = {}) {
  let busy = false;
  return async (fn) => {
    if (busy) return null;
    busy = true;
    try {
      onStart(); // 在 try 里：它丢错也会复位（复核小事）
      return await fn();
    } catch (e) {
      console.warn(`[invites] 出错：${e && e.name ? e.name : '未知'}`);
      return fail('error', T.generic);
    } finally {
      busy = false;
      onEnd();
    }
  };
}

/** 候选里第一个还在画面上、自己和祖先都没被 hidden 的元素（找焦点的下一站，2f-3 审核 7）。 */
export function firstVisible(cands) {
  return cands.find((el) => el && el.isConnected && !el.closest('[hidden]')) || null;
}

/** iPhone 分享面板（必须在点击当下叫）：'done' | 'cancel'（使用者关掉，不算错）| 'fail'。 */
export async function shareInvite(code, nav = globalThis.navigator) {
  if (!canShare(nav)) return 'fail';
  try {
    await nav.share({ text: shareText(code) });
    return 'done';
  } catch (e) {
    // AbortError：使用者关掉；InvalidStateError：上一个分享面板还开着（连按）。都不算错（2f-3 审核 8）
    return e && (e.name === 'AbortError' || e.name === 'InvalidStateError') ? 'cancel' : 'fail';
  }
}

// ----------------------- 明细（Task 9） -----------------------

/** 使用明细：{ok:true, uses} 或失败。 */
export async function loadUses(deps, code) {
  const r = await ownerCall(deps, 'uses', { code });
  if (!r.ok) return r;
  return Array.isArray(r.data.uses) ? { ok: true, uses: r.data.uses } : fail('error', T.generic);
}

/**
 * 明细一列要显示什么（纯函数）。已删除：不显示邮箱（用户决定 6）、没有移除；站主、注册未完成：没有移除；
 * 邮箱已清空但还没标已删除（删除做到一半，S6）：「删除未完成的用户」、可以再移除（服务器会接着删）。
 */
export function useRowView(u) {
  const when = dateLabelMY(u.used_at);
  const registered = when ? `注册于 ${when}` : '';
  if (u.deleted) return { title: T.deletedUser, detail: registered, owner: false, removable: false, removeLabel: '' };
  if (u.pending) return { title: u.email || T.unfinishedUser, detail: T.pendingUser, owner: false, removable: false, removeLabel: '' };
  const title = u.email || T.unfinishedUser;
  if (u.owner) return { title, detail: registered, owner: true, removable: false, removeLabel: '' };
  return { title, detail: registered, owner: false, removable: true, removeLabel: `${T.remove} ${title}` };
}

export const activeActionLabel = (inv) => (inv.active ? T.disable : T.enable);

/** 停用／启用，成功就通知列表重载——不管明细页关了没（2f-3 审核 2：回应没到就按返回，列表也要更新）。 */
export async function toggleAndNotify(deps, inv, { onChanged }) {
  const r = await toggleInviteActive(deps, inv);
  if (r.ok) onChanged();
  return r;
}

/**
 * 停用／重新启用：改完再拉一次清单，拿服务器算的状态（启用后可能是已过期、已用完）；
 * 拉不到就用本地推算。回 {ok:true, invite} 或失败。
 */
export async function toggleInviteActive(deps, inv) {
  const active = !inv.active;
  const r = await ownerCall(deps, 'set_active', { code: inv.code, active });
  if (!r.ok) return r;
  const list = await loadInvites(deps);
  const fresh = list.ok ? list.invites.find((x) => x.code === inv.code) : null;
  if (fresh) return { ok: true, invite: fresh };
  return { ok: true, invite: { ...inv, active, status: active ? (inv.status === 'disabled' ? 'active' : inv.status) : 'disabled' } };
}

let removing = false;
/**
 * 移除用户：两次确认（第二次输入「删除」）→ 挡住画面 → remove_user {code, use_id} → 放开 → 失败才说明。
 * 回 'done' | 'cancel' | 'fail'。不能移除的列（已删除、站主、注册未完成）直接回 'cancel'。正在跑时再叫回 'cancel'。
 * 'cancel' 以外：放开画面后先 await onSettled()（重新载入明细，以服务器为准，S4），再弹失败或超时说明
 *（2f-3 审核 4：说明里「列表已重新载入」要是真的）。onSettled 丢错只记下，照样说明。
 * opts.dialogs、opts.block（挡画面，回放开的函数）测试可注入。
 */
export async function runRemoveUser(deps, {
  code, use, dialogs = { choiceDialog, confirmDialog, messageDialog }, block = () => busyOverlay(T.removing), onSettled = async () => {},
}) {
  const view = useRowView(use);
  if (!view.removable || removing) return 'cancel';
  removing = true;
  try {
    const who = use.email ? ` ${use.email} 的` : '这个用户的';
    const first = await dialogs.choiceDialog({
      title: T.removeTitle,
      message: `会永久删除${who}账号和全部数据，无法复原。对方想再用需要新的邀请码。`,
      buttons: [
        { label: T.cancel, value: null, focus: true },
        { label: T.removeContinue, value: 'continue', destructive: true },
      ],
    });
    if (first !== 'continue') return 'cancel';
    const sure = await dialogs.confirmDialog({
      title: T.removeConfirmTitle, message: T.removeConfirmMessage, requireText: T.removeRequire,
      confirmLabel: T.removeConfirmLabel, destructive: true,
    });
    if (!sure) return 'cancel';
    const unblock = block();
    let r;
    try {
      r = await ownerCall(deps, 'remove_user', { code, use_id: use.id });
    } finally {
      unblock();
    }
    try {
      await onSettled();
    } catch (e) {
      console.warn(`[invites] 重新载入明细出错：${e && e.name ? e.name : '未知'}`);
    }
    if (r.ok) return 'done';
    if (r.reason === 'timeout') await dialogs.messageDialog({ title: T.removeTimeoutTitle, message: T.removeTimeout });
    else await dialogs.messageDialog({ title: T.removeFailTitle, message: r.message });
    return 'fail';
  } finally {
    removing = false;
  }
}

// ======================= 画面（DOM；Task 11 headless 截图确认） =======================

let seq = 0;

// 码：画面上大写等宽；读屏念逐字分开的版本（画面那份对读屏隐藏）
const codeLabel = (code, cls) => h('span', { class: cls },
  h('span', { 'aria-hidden': 'true' }, formatCode(code)),
  h('span', { class: 'sr-only' }, `邀请码 ${spokenCode(code)}`));

/**
 * 有焦点的东西刚被藏起来或换掉（had：改动前焦点在 container 里）：焦点还在看得见的地方就不动，
 * 否则放到第一个看得见的后备（VoiceOver 才不会掉回页首，2f-3 审核 7）。
 * 焦点变成 body 时 container.contains 就是 false，所以不用另外判断。a（目前焦点）测试可注入。
 */
export function keepFocus(container, had, fallbacks, a = document.activeElement) {
  if (!had) return;
  if (a && container.contains(a) && firstVisible([a])) return;
  const t = firstVisible(fallbacks);
  if (t) t.focus({ preventScroll: true });
}

/**
 * openInvitesPage(store, { userId, fetchFn, onOwnerChanged?, restoreFocus? }) → { close }
 * onOwnerChanged()：服务器说「没有权限」时叫（设置页把入口藏起来）。
 * restoreFocus()：关闭时开启者（设置页那一列）已被藏起来，改由它放焦点。
 */
export function openInvitesPage(store, {
  userId, fetchFn = (url, init) => fetch(url, init), onOwnerChanged = () => {}, restoreFocus = () => {},
} = {}) {
  const opener = document.activeElement;
  const uid = `invpage-${++seq}`;
  const deps = { store, fetchFn, userId };
  let closed = false;
  let loading = false;

  const backBtn = h('button', { type: 'button', class: 'nav-back', on: { click: () => close() } },
    h('span', { class: 'nav-back-chevron', 'aria-hidden': 'true' }, icon('chevron-left', 22)),
    h('span', null, T.back));
  const bar = h('header', { class: 'nav-page-bar' },
    backBtn, h('h2', { class: 'nav-page-title', id: `${uid}-title` }, T.title), h('span', { 'aria-hidden': 'true' }));

  // 状态（载入中／离线／没有权限…）：role=status，文字变了读屏会念
  const statusText = h('p', { class: 'invites-status-text', tabindex: '-1' }); // 重试按钮被藏起来时焦点的下一站
  const statusBtn = h('button', { type: 'button', class: 'invites-status-button pressable', hidden: true });
  const status = h('div', { class: 'invites-status', role: 'status' }, statusText, statusBtn);

  const addMain = h('button', { type: 'button', class: 'cat-row-main', on: { click: () => openNewInvite() } },
    h('span', { class: 'cat-row-plus', 'aria-hidden': 'true' }, icon('plus', 20)),
    h('span', { class: 'cat-row-name' }, T.add));
  const list = h('ul', { class: 'inset-group cat-list invite-list', role: 'list', 'aria-label': T.title, hidden: true });
  const footer = h('p', { class: 'settings-footer', hidden: true }, T.footer);
  let pendingReload = false; // 载入中又要求重新载入（例如明细页改了东西）：这次完了再载一次，才拿得到最新的

  function showStatus(text, button) {
    statusText.textContent = text;
    status.hidden = false;
    statusBtn.hidden = !button;
    if (button) {
      statusBtn.textContent = button.label;
      statusBtn.onclick = button.onClick;
    }
  }

  // 每次重画都是新节点：明细页关闭时焦点放回同一个码那一列（data-code），不在了就放到「新增邀请码」
  function rowOf(inv) {
    return h('li', { class: 'cat-row' },
      h('button', {
        type: 'button', class: 'cat-row-main invite-row', 'data-code': inv.code,
        on: { click: () => openInviteDetail(deps, inv, { onChanged: () => reload(), onOwnerChanged, restoreFocus: () => focusRow(inv.code) }) },
      },
      h('span', { class: 'invite-row-text' },
        codeLabel(inv.code, 'invite-code'),
        h('span', { class: 'invite-meta' }, inviteMeta(inv)),
        inv.note ? h('span', { class: 'invite-note' }, inv.note) : null),
      h('span', { class: 'cat-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16))));
  }
  function focusRow(code) {
    if (closed) return;
    const row = [...list.querySelectorAll('[data-code]')].find((b) => b.dataset.code === code);
    (row || addMain).focus({ preventScroll: true });
  }

  function renderList(invites) {
    const a = document.activeElement;
    const hadPage = page.contains(a); // 例如焦点在状态文字（刚按「重试」）：载入成功后它会被藏起来（复核 A）
    const hadFocus = list.contains(a);
    const code = hadFocus && a.dataset ? a.dataset.code : undefined; // 重画后放回同一个码那一列（审核 7）
    list.replaceChildren(h('li', { class: 'cat-row cat-row-add' }, addMain), ...invites.map(rowOf));
    list.hidden = false;
    footer.hidden = false;
    if (invites.length) status.hidden = true;
    else showStatus(T.empty);
    if (code) focusRow(code);
    else if (hadFocus && !list.contains(document.activeElement)) addMain.focus({ preventScroll: true });
    keepFocus(page, hadPage, [addMain, backBtn]);
  }

  async function reload() {
    if (closed) return;
    if (loading) { pendingReload = true; return; }
    loading = true;
    if (list.hidden) {
      const had = page.contains(document.activeElement); // 例如刚按「重试」：按钮会被藏起来
      showStatus(T.loading);
      keepFocus(page, had, [statusBtn, statusText, backBtn]);
    }
    let r;
    try {
      r = await loadInvites(deps);
    } finally {
      loading = false;
    }
    if (closed) return;
    if (pendingReload) { pendingReload = false; reload(); return; }
    if (r.ok) { renderList(r.invites); return; }
    const had = page.contains(document.activeElement);
    list.hidden = true;
    footer.hidden = true;
    if (r.reason === 'denied') onOwnerChanged();
    if (r.reason === 'offline' || r.reason === 'timeout' || r.reason === 'error') showStatus(r.message, { label: T.retryButton, onClick: () => reload() });
    else if (r.reason === 'switched') showStatus(r.message, { label: T.reloadButton, onClick: () => location.reload() });
    else showStatus(r.message);
    keepFocus(page, had, [statusBtn, statusText, backBtn]);
  }

  function openNewInvite() {
    openNewInviteSheet(deps, {
      onCreated: () => reload(),
      onDenied: () => { onOwnerChanged(); return reload(); },
      // 超时说明关掉后：列表若载入失败（「新增邀请码」被藏），焦点交给「重试」（复核 B）
      afterExplain: () => { if (!closed) keepFocus(page, true, [statusBtn, statusText, backBtn]); },
    });
  }

  const body = h('div', { class: 'nav-page-body' }, status, list, footer);
  const page = h('div', { class: 'nav-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title` }, bar, body);
  trapFocus(page, page);

  const handle = pushLayer({
    element: page,
    onClose: () => {
      closed = true;
      page.classList.remove('is-visible');
      const remove = () => page.remove();
      page.addEventListener('transitionend', (e) => { if (e.target === page) remove(); });
      setTimeout(remove, 450); // 后备
      // 设置页那一列可能已被藏起来（服务器说没有权限）：focus 没作用，改用后备
      if (opener && typeof opener.focus === 'function' && firstVisible([opener])) opener.focus({ preventScroll: true });
      else restoreFocus();
    },
  });
  function close() { handle.close(); }

  document.body.append(page);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) page.classList.add('is-visible'); }));
  reload();
  return { close };
}

/**
 * 明细子画面（推入在邀请码页上面）：码的资料、停用／重新启用、用这个码注册的人（可移除）。
 * onChanged()：有改动（停用、移除）时叫，邀请码页重新载入；restoreFocus()：关闭后焦点放回列表那一列。
 */
function openInviteDetail(deps, invite, { onChanged, onOwnerChanged, restoreFocus }) {
  const uid = `invdet-${++seq}`;
  let inv = invite;
  let closed = false;
  let toggling = false;

  const backBtn = h('button', { type: 'button', class: 'nav-back', on: { click: () => close() } },
    h('span', { class: 'nav-back-chevron', 'aria-hidden': 'true' }, icon('chevron-left', 22)),
    h('span', null, T.detailBack));
  const title = h('h2', { class: 'nav-page-title invite-code', id: `${uid}-title` });
  const bar = h('header', { class: 'nav-page-bar' }, backBtn, title, h('span', { 'aria-hidden': 'true' }));

  const infoRow = (label) => {
    const detail = h('span', { class: 'inset-row-detail' });
    return { el: h('div', { class: 'inset-row' }, h('span', { class: 'inset-row-label' }, label), detail), detail };
  };
  const rStatus = infoRow(T.statusRow);
  const rUses = infoRow(T.usesRow);
  const rExpiry = infoRow(T.expiryRow);
  const rNote = infoRow(T.noteRow);
  rNote.detail.classList.add('invite-detail-note');
  rNote.el.classList.add('has-long-detail'); // 长备注不把「备注」挤成直排
  const toggleLabel = h('span', { class: 'inset-row-label' });
  const toggleBtn = h('button', { type: 'button', class: 'inset-row is-action', on: { click: () => onToggle() } }, toggleLabel);

  function renderInfo() {
    title.replaceChildren(h('span', { 'aria-hidden': 'true' }, formatCode(inv.code)), h('span', { class: 'sr-only' }, `邀请码 ${spokenCode(inv.code)}`));
    rStatus.detail.textContent = statusLabel(inv.status);
    rUses.detail.textContent = usesLabel(inv.used_count, inv.max_uses);
    rExpiry.detail.textContent = expiryLabel(inv.expires_at);
    rNote.detail.textContent = inv.note || '';
    rNote.el.hidden = !inv.note;
    toggleLabel.textContent = activeActionLabel(inv);
  }

  async function onToggle() {
    if (toggling) return;
    toggling = true;
    toggleBtn.setAttribute('aria-disabled', 'true');
    let r;
    try {
      r = await toggleAndNotify(deps, inv, { onChanged }); // 成功就通知列表，就算这页已经关了（审核 2）
    } finally {
      toggling = false;
      toggleBtn.removeAttribute('aria-disabled');
    }
    if (closed) return;
    if (r.ok) {
      inv = r.invite;
      renderInfo();
      announce(statusLabel(inv.status));
      return;
    }
    if (r.reason === 'denied') onOwnerChanged();
    await messageDialog({ title: T.toggleFailTitle, message: r.message });
  }

  // ---------- 用这个码注册的人 ----------
  const usersStatus = h('p', { class: 'invites-status-text invite-users-status', role: 'status', tabindex: '-1' });
  const usersRetry = h('button', { type: 'button', class: 'invites-status-button pressable', hidden: true, on: { click: () => loadUsers() } }, T.retryButton);
  const usersBox = h('div', { class: 'invites-status invite-users-box' }, usersStatus, usersRetry);
  const usersList = h('ul', { class: 'inset-group invite-users', role: 'list', 'aria-labelledby': `${uid}-users`, hidden: true });
  const usersFooter = h('p', { class: 'settings-footer', hidden: true }, T.usersFooter);
  let usersLoading = false;

  function userRow(u) {
    const v = useRowView(u);
    const tail = v.owner
      ? h('span', { class: 'use-tag' }, T.ownerTag)
      : v.removable
        ? h('button', { type: 'button', class: 'use-remove', 'aria-label': v.removeLabel, on: { click: () => onRemove(u) } }, T.remove)
        : null;
    return h('li', { class: 'inset-row use-row', 'data-use': String(u.id) },
      h('span', { class: 'use-row-text' },
        h('span', { class: 'use-row-title' }, v.title),
        v.detail ? h('span', { class: 'use-row-detail' }, v.detail) : null),
      tail);
  }

  async function loadUsers() {
    if (usersLoading || closed) return;
    usersLoading = true;
    if (usersList.hidden) {
      const had = page.contains(document.activeElement); // 刚按「重试」：按钮会被藏起来
      usersStatus.textContent = T.loading;
      usersBox.hidden = false;
      usersRetry.hidden = true;
      keepFocus(page, had, [usersRetry, usersStatus, toggleBtn, backBtn]);
    }
    let r;
    try {
      r = await loadUses(deps, inv.code);
    } finally {
      usersLoading = false;
    }
    if (closed) return;
    if (!r.ok) {
      const had = page.contains(document.activeElement);
      if (r.reason === 'denied') onOwnerChanged();
      usersList.hidden = true;
      usersFooter.hidden = true;
      usersStatus.textContent = r.message;
      usersBox.hidden = false;
      usersRetry.hidden = !(r.reason === 'offline' || r.reason === 'timeout' || r.reason === 'error');
      keepFocus(page, had, [usersRetry, usersStatus, toggleBtn, backBtn]);
      return;
    }
    const hadPage = page.contains(document.activeElement); // 焦点在状态文字（刚按「重试」）：成功后它会被藏起来（复核 A）
    const hadFocus = usersList.contains(document.activeElement) ? document.activeElement.closest('[data-use]') : null;
    usersList.replaceChildren(...r.uses.map(userRow));
    usersList.hidden = r.uses.length === 0;
    usersFooter.hidden = !r.uses.some((u) => useRowView(u).removable);
    usersBox.hidden = r.uses.length > 0;
    usersStatus.textContent = r.uses.length ? '' : T.usersEmpty;
    usersRetry.hidden = true;
    if (hadFocus) {
      // 移除后那一列重画了：焦点放回同一列（已变成「已删除的用户」），不掉回页首
      const again = usersList.querySelector(`[data-use="${hadFocus.dataset.use}"]`);
      if (again) { again.tabIndex = -1; again.focus({ preventScroll: true }); }
    }
    keepFocus(page, hadPage, [usersStatus, toggleBtn, backBtn]);
  }

  async function onRemove(u) {
    // 先重新载入明细、再弹失败说明（审核 4）；列表页也跟着重载
    const r = await runRemoveUser(deps, { code: inv.code, use: u, onSettled: async () => { onChanged(); await loadUsers(); } });
    if (r === 'done' && !closed) announce(T.removed);
  }

  const body = h('div', { class: 'nav-page-body' },
    h('section', { class: 'settings-section' },
      h('div', { class: 'inset-group' }, rStatus.el, rUses.el, rExpiry.el, rNote.el)),
    h('section', { class: 'settings-section' }, h('div', { class: 'inset-group' }, toggleBtn)),
    h('section', { class: 'settings-section', 'aria-labelledby': `${uid}-users` },
      h('h2', { class: 'settings-header', id: `${uid}-users` }, T.usersHeader),
      usersBox, usersList, usersFooter));
  const page = h('div', { class: 'nav-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title` }, bar, body);
  trapFocus(page, page);

  const handle = pushLayer({
    element: page,
    onClose: () => {
      closed = true;
      page.classList.remove('is-visible');
      const remove = () => page.remove();
      page.addEventListener('transitionend', (e) => { if (e.target === page) remove(); });
      setTimeout(remove, 450); // 后备
      restoreFocus();
    },
  });
  function close() { handle.close(); }

  renderInfo();
  document.body.append(page);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) page.classList.add('is-visible'); }));
  loadUsers();
}

/** 新增邀请码 sheet：次数（步进器）、有效期（分段 4 选 1）、备注 →「生成」→ 结果 sheet。 */
function openNewInviteSheet(deps, { onCreated, onDenied, afterExplain = () => {} }) {
  const uid = `invnew-${++seq}`;
  let uses = USES_MIN;
  let days = DEFAULT_DAYS;
  let saving = false;
  let confirming = false;
  // 生成中：按钮用 aria-disabled＋「正在生成…」（不用 disabled：Safari 会丢焦点）；出意外也一定复位（审核 6）
  const run = createGuardedRunner({
    onStart: () => {
      saving = true;
      sheet.rightButton.setAttribute('aria-disabled', 'true');
      sheet.rightButton.textContent = T.generating;
    },
    onEnd: () => {
      saving = false;
      sheet.rightButton.removeAttribute('aria-disabled');
      sheet.rightButton.textContent = T.generate;
    },
  });

  // ---------- 次数：数值放在按钮中间（HIG：步进器影响的值要一眼看得到）----------
  const value = h('span', { class: 'stepper-value', id: `${uid}-uses`, 'aria-live': 'polite' }, String(uses));
  const minus = h('button', { type: 'button', class: 'stepper-button', 'aria-label': T.fewer, on: { click: () => setUses(uses - 1) } }, '−');
  const plus = h('button', { type: 'button', class: 'stepper-button', 'aria-label': T.more, on: { click: () => setUses(uses + 1) } }, '+');
  function setUses(n) {
    uses = clampUses(n);
    value.textContent = String(uses);
    // 到边界用 aria-disabled（不用 disabled：焦点不会被丢掉）
    minus.setAttribute('aria-disabled', uses <= USES_MIN ? 'true' : 'false');
    plus.setAttribute('aria-disabled', uses >= USES_MAX ? 'true' : 'false');
  }
  setUses(uses);
  const usesRow = h('div', { class: 'entry-row' },
    h('span', { class: 'entry-row-label', id: `${uid}-uses-label` }, T.usesLabel),
    h('div', { class: 'stepper', role: 'group', 'aria-labelledby': `${uid}-uses-label ${uid}-uses` }, minus, value, plus));

  // ---------- 有效期 ----------
  const seg = optionSegmented({
    options: VALIDITY_OPTIONS.map((o) => ({ id: o.days === null ? 'never' : String(o.days), label: o.label })),
    value: String(DEFAULT_DAYS),
    label: T.validityLabel,
    onChange: (id) => { days = id === 'never' ? null : Number(id); },
  });

  // ---------- 备注 ----------
  const note = h('input', {
    class: 'entry-input entry-note', type: 'text', maxlength: String(NOTE_MAX), placeholder: T.notePlaceholder,
    'aria-label': T.noteLabel, autocomplete: 'off', enterkeyhint: 'done',
  });
  note.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); note.blur(); }
  });

  const content = h('div', { class: 'entry' },
    h('div', { class: 'entry-section' }, h('div', { class: 'entry-card entry-list' }, usesRow)),
    h('div', { class: 'entry-section' },
      h('h3', { class: 'entry-section-label', id: `${uid}-validity` }, T.validityLabel), seg.element),
    h('div', { class: 'entry-section' },
      h('div', { class: 'entry-card entry-list' }, h('div', { class: 'entry-row' }, note)),
      h('p', { class: 'settings-footer' }, T.newFooter)));

  const isDirty = () => uses !== USES_MIN || days !== DEFAULT_DAYS || note.value.trim() !== '';
  async function onDismissRequest(close) {
    if (saving || confirming) return;
    if (!isDirty()) { close(); return; }
    confirming = true;
    try {
      if (await confirmDiscard()) close();
    } finally {
      confirming = false;
    }
  }

  async function generate() {
    if (confirming) return;
    const r = await run(() => createInvite(deps, { maxUses: uses, days, note: note.value }));
    if (r === null) return; // 已经在生成
    const next = createFollowUp(r); // 超时：服务器可能已经生成 → 关表单、重载列表再说明（审核 3）
    if (next.close) sheet.close();
    if (r.ok) { openResultSheet(r.code, { onClosed: onCreated }); return; }
    // 等列表重载完才说明（文案说「列表已重新载入」，复核 B；同移除用户的做法）
    if (next.reload) await (r.reason === 'denied' ? onDenied : onCreated)();
    await messageDialog({ title: r.reason === 'timeout' ? T.noReplyTitle : T.createFailTitle, message: next.message });
    if (next.close) afterExplain();
  }

  const sheet = openSheet({
    title: T.newTitle,
    content,
    leftAction: { label: T.cancel, onClick: () => sheet.requestDismiss() },
    rightAction: { label: T.generate, bold: true, onClick: () => { generate(); } },
    onDismissRequest,
  });
  minus.focus({ preventScroll: true });
}

/** 生成结果：大字码＋复制＋分享（有分享面板才显示）。关闭后列表重新载入。 */
function openResultSheet(code, { onClosed }) {
  // 长按只选得到看得见的码（读屏那段不可选取，审核 1）
  const bigText = h('span', { class: 'invite-big-code-text', 'aria-hidden': 'true' }, formatCode(code));
  const big = h('p', { class: 'invite-big-code' }, bigText, h('span', { class: 'sr-only' }, `邀请码 ${spokenCode(code)}`));
  let sharing = false;
  let copyTimer = null;
  const copyBtn = h('button', { type: 'button', class: 'invite-action pressable', on: { click: () => onCopy() } }, T.copy);
  const shareBtn = canShare(globalThis.navigator)
    ? h('button', { type: 'button', class: 'invite-action is-secondary pressable', on: { click: () => onShare() } }, T.share)
    : null;
  const hint = h('p', { class: 'invite-result-hint' }, T.resultHint);

  async function onCopy() {
    const ok = await copyInvite(code);
    clearTimeout(copyTimer);
    if (ok) {
      copyBtn.textContent = T.copied;
      announce(T.copied);
      copyTimer = setTimeout(() => { copyBtn.textContent = T.copy; }, 2000);
      return;
    }
    // 复制不了：选取画面上的码，让使用者长按复制
    const sel = globalThis.getSelection && globalThis.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(bigText);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    hint.textContent = T.copyFail;
    announce(T.copyFail);
  }
  function onShare() {
    if (sharing) return; // 分享面板还开着（审核 8）
    sharing = true;
    // shareInvite 会在这次点击里同步叫 navigator.share（iOS 要在手势当下）
    shareInvite(code)
      .then((r) => { if (r === 'fail') messageDialog({ title: T.share, message: T.shareFail }); })
      .finally(() => { sharing = false; });
  }

  const content = h('div', { class: 'entry invite-result' },
    big, hint, h('div', { class: 'invite-actions' }, copyBtn, shareBtn));
  const sheet = openSheet({
    title: T.resultTitle,
    content,
    rightAction: { label: T.done, bold: true, onClick: () => sheet.close() },
    onClosed: () => { clearTimeout(copyTimer); onClosed(); },
  });
  copyBtn.focus({ preventScroll: true });
}
