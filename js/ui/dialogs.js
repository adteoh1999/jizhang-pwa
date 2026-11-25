// iOS 风格 alert（置中、270pt 宽）与 action sheet（底部、分组按钮 + 独立的取消按钮）。
// 全部入栈（nav.js）：Esc → popLayer。action sheet 点背景 = 取消（null）；alert 点背景不关闭。
import { h } from './dom.js';
import { pushLayer } from './nav.js';

let seq = 0;

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 焦点留在 panel 里（Tab / Shift+Tab 循环）。sheet.js 也用。 */
export function trapFocus(overlay, panel) {
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert]'));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// 建立遮罩 + 面板，入栈；回传 { overlay, close }。onClosed 在关闭时（任何途径）呼叫一次。
function present({ kind, panel, onClosed, onBackdrop }) {
  // 已经有「需要重新载入」阻挡画面：不再叠对话框（例如账本换掉后的「保存失败」），当成马上关掉
  if (document.querySelector('[data-db-closed]')) {
    queueMicrotask(() => { if (onClosed) onClosed(); });
    return { close() {}, overlay: null };
  }
  const opener = document.activeElement;
  const overlay = h('div', { class: `overlay overlay-${kind}` }, panel);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && onBackdrop) onBackdrop();
  });
  trapFocus(overlay, panel);

  let closed = false;
  const handle = pushLayer({
    element: overlay, // 上面再开一层时自动 inert
    onClose: () => {
      closed = true;
      overlay.classList.remove('is-visible');
      const remove = () => overlay.remove();
      overlay.addEventListener('transitionend', (e) => { if (e.target === overlay) remove(); });
      setTimeout(remove, 400); // 后备
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
      onClosed();
    },
  });
  document.body.append(overlay);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) overlay.classList.add('is-visible'); }));
  return { overlay, close: handle.close };
}

function alertPanel({ title, message, extra, buttons }) {
  const id = `dlg-${++seq}`;
  const panel = h('div', {
    class: 'alert', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': `${id}-title`, 'aria-describedby': message ? `${id}-msg` : null,
  },
  h('div', { class: 'alert-body' },
    h('h2', { class: 'alert-title', id: `${id}-title` }, title),
    message ? h('p', { class: 'alert-message', id: `${id}-msg` }, message) : null,
    extra),
  h('div', { class: `alert-buttons${buttons.length > 2 ? ' is-stacked' : ''}` }, buttons));
  return panel;
}

function alertButton(label, { style = 'default', bold = false, onClick } = {}) {
  return h('button', {
    type: 'button',
    class: `alert-button${style === 'destructive' ? ' is-destructive' : ''}${bold ? ' is-bold' : ''}`,
    on: { click: onClick },
  }, label);
}

/** 确认对话框；requireText：输入完全相同的文字才能按确认。回传 true / false。 */
export function confirmDialog({
  title, message, confirmLabel, cancelLabel = '取消', destructive = false, requireText,
}) {
  return new Promise((resolve) => {
    let result = false;
    let input = null;
    const confirmBtn = alertButton(confirmLabel, {
      style: destructive ? 'destructive' : 'default',
      bold: !destructive, // 非破坏性时确认是建议动作（粗体）；破坏性时不设为默认按钮
      onClick: () => { result = true; close(); },
    });
    const cancelBtn = alertButton(cancelLabel, { onClick: () => close() });
    if (typeof requireText === 'string') {
      input = h('input', {
        class: 'alert-input', type: 'text', autocomplete: 'off', autocapitalize: 'off',
        autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
        'aria-label': `请输入「${requireText}」以确认`, placeholder: requireText,
      });
      confirmBtn.disabled = true;
      input.addEventListener('input', () => { confirmBtn.disabled = input.value !== requireText; });
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
        if (e.key === 'Enter' && !confirmBtn.disabled) { e.preventDefault(); confirmBtn.click(); }
      });
    }
    // HIG：取消在前（leading），主要动作在后（trailing）
    // 输入框视觉保持 iOS 的紧凑高度，外层包一个 ≥44px 的点击区
    const field = input
      ? h('div', {
        class: 'alert-field',
        on: { pointerdown: (e) => { if (e.target !== input) { e.preventDefault(); input.focus(); } } },
      }, input)
      : null;
    const panel = alertPanel({ title, message, extra: field, buttons: [cancelBtn, confirmBtn] });
    const { close } = present({ kind: 'alert', panel, onClosed: () => resolve(result) });
    (input || (destructive ? cancelBtn : confirmBtn)).focus({ preventScroll: true });
  });
}

/**
 * 多选一对话框。buttons：[{label, value, bold, destructive, keepOpen, onClick, focus}]。三个以上会直排。
 * 一定要有一个能关窗的「取消」类按钮（iPhone 没有 Esc，alert 点背景也不关）。
 * keepOpen 的按钮只在点击事件里同步呼叫 onClick、不关窗（例如导出 CSV：navigator.share 要在手势里）。
 * 回传按下的 value；Esc 关掉回 null。
 */
export function choiceDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    let result = null;
    let close = () => {};
    const els = buttons.map((b) => alertButton(b.label, {
      style: b.destructive ? 'destructive' : 'default',
      bold: !!b.bold,
      onClick: () => {
        if (b.keepOpen) { if (b.onClick) b.onClick(); return; }
        result = b.value ?? null;
        close();
      },
    }));
    const panel = alertPanel({ title, message, buttons: els });
    ({ close } = present({ kind: 'alert', panel, onClosed: () => resolve(result) }));
    const fi = buttons.findIndex((b) => b.focus);
    const bi = buttons.findIndex((b) => b.bold);
    els[fi >= 0 ? fi : bi >= 0 ? bi : els.length - 1].focus({ preventScroll: true });
  });
}

/** 只有「好」按钮的讯息对话框。 */
export function messageDialog({ title, message }) {
  return new Promise((resolve) => {
    const ok = alertButton('好', { bold: true, onClick: () => close() });
    const panel = alertPanel({ title, message, buttons: [ok] });
    const { close } = present({ kind: 'alert', panel, onClosed: () => resolve() });
    ok.focus({ preventScroll: true });
  });
}

/** 底部 action sheet；回传被按的 label，取消 / Esc / 点背景 → null。 */
export function actionSheet({ title, message, actions }) {
  return new Promise((resolve) => {
    let result = null;
    const id = `dlg-${++seq}`;
    const pick = (label) => () => { result = label; close(); };
    const main = actions.filter((a) => a.style !== 'cancel');
    const cancel = actions.find((a) => a.style === 'cancel');
    const head = title || message
      ? h('div', { class: 'sheet-head' },
        title ? h('h2', { class: 'sheet-title', id: `${id}-title` }, title) : null,
        message ? h('p', { class: 'sheet-message', id: `${id}-msg` }, message) : null)
      : null;
    const buttons = main.map((a) => h('button', {
      type: 'button', class: `sheet-button${a.style === 'destructive' ? ' is-destructive' : ''}`,
      on: { click: pick(a.label) },
    }, a.label));
    const cancelBtn = h('button', {
      type: 'button', class: 'sheet-button sheet-cancel', on: { click: () => close() },
    }, cancel ? cancel.label : '取消');
    const panel = h('div', {
      class: 'action-sheet', role: 'dialog', 'aria-modal': 'true',
      'aria-labelledby': title ? `${id}-title` : null,
      'aria-describedby': message ? `${id}-msg` : null,
      'aria-label': title ? null : '选项',
    },
    h('div', { class: 'sheet-group' }, head, buttons),
    cancelBtn);
    const { close } = present({
      kind: 'sheet', panel, onClosed: () => resolve(result), onBackdrop: () => close(),
    });
    (buttons[0] || cancelBtn).focus({ preventScroll: true });
  });
}
