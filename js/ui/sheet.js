// iOS 风格的底部 sheet（large detent）：从底部滑上、背景变暗、顶部把手可下拉关闭。
// 入栈（nav.js）：Esc → onDismiss。下拉 / 点背景 / Esc 都走 requestDismiss，
// 由呼叫者的 onDismissRequest 决定要不要关闭（例如先确认「放弃这次修改？」）。
import { h } from './dom.js';
import { trapFocus } from './dialogs.js';
import { pushLayer, trackExit } from './nav.js';

let seq = 0;

const DISMISS_RATIO = 0.3; // 拉超过 sheet 高度 30% 就关闭
const DISMISS_VELOCITY = 0.5; // 或放手时速度 > 0.5 px/ms
const VELOCITY_WINDOW = 100; // 速度只看放手前 100ms 内的移动
const VELOCITY_STALE = 50; // 最后一次移动到放手超过 50ms → 视为停住
const VELOCITY_MIN_DRAG = 10; // 用速度判断关闭时，至少要下拉 10px

function headerButton(action, side) {
  if (!action) return h('span', { class: `modal-sheet-${side}` });
  return h('button', {
    type: 'button',
    class: `modal-sheet-${side} modal-sheet-action${action.bold ? ' is-bold' : ''}`,
    on: { click: action.onClick },
  }, action.label);
}

/**
 * openSheet({ title, content, leftAction?, rightAction?, onDismissRequest?, onClosed? })
 * action: { label, onClick, bold? }
 * onDismissRequest(close)：下拉 / 点背景 / Esc 时呼叫；没给就直接关闭。
 * onClosed()：任何途径关闭后呼叫一次。
 * 回传 { close, requestDismiss, overlay, panel, leftButton, rightButton }。
 */
export function openSheet({
  title, content, leftAction, rightAction, onDismissRequest, onClosed,
}) {
  const opener = document.activeElement;
  const id = `msheet-${++seq}`;
  const leftButton = headerButton(leftAction, 'left');
  const rightButton = headerButton(rightAction, 'right');
  const header = h('div', { class: 'modal-sheet-header' },
    h('div', { class: 'modal-sheet-grabber', 'aria-hidden': 'true' }),
    h('div', { class: 'modal-sheet-bar' },
      leftButton,
      h('h2', { class: 'modal-sheet-title', id: `${id}-title` }, title),
      rightButton));
  const body = h('div', { class: 'modal-sheet-body' }, content);
  const panel = h('div', {
    class: 'modal-sheet is-entering', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-title`,
  }, header, body);
  const overlay = h('div', { class: 'overlay overlay-modal' }, panel);
  trapFocus(overlay, panel);

  let closed = false;
  const requestDismiss = () => {
    if (closed) return;
    if (onDismissRequest) onDismissRequest(close);
    else close();
  };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) requestDismiss(); });

  // 键盘弹出时（visualViewport 变小），把 sheet 底部垫高到键盘上方
  const vv = window.visualViewport;
  const onViewport = () => {
    const kb = vv ? window.innerHeight - vv.height - vv.offsetTop : 0;
    panel.style.setProperty('--keyboard', `${kb > 0 ? Math.round(kb) : 0}px`);
  };
  if (vv) {
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }

  // 下拉关闭：只在把手 / 标题列上（不含按钮），输入框与可滚动的内容不受影响
  let drag = null;
  const setOffset = (y) => { panel.style.transform = y > 0 ? `translateY(${y}px)` : ''; };
  // 进场曲线只用在进场：播完、开始下拉、或关闭时拿掉（之后的回弹维持 ease-out）
  const endEntering = () => panel.classList.remove('is-entering');
  panel.addEventListener('transitionend', (e) => { if (e.target === panel) endEntering(); });
  setTimeout(endEntering, 450); // 后备
  header.addEventListener('pointerdown', (e) => {
    if (closed || e.button > 0 || e.target.closest('button, input')) return;
    endEntering(); // 必须：.is-dragging 的优先级比进场规则低
    drag = { id: e.pointerId, y0: e.clientY, dy: 0, samples: [{ t: e.timeStamp, y: e.clientY }] };
    panel.classList.add('is-dragging');
    try { header.setPointerCapture(e.pointerId); } catch { /* 部分浏览器不支援 */ }
  });
  header.addEventListener('pointermove', (e) => {
    if (closed || !drag || e.pointerId !== drag.id) return;
    drag.dy = e.clientY - drag.y0;
    drag.samples.push({ t: e.timeStamp, y: e.clientY });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > VELOCITY_WINDOW) drag.samples.shift();
    // 只能往下拉（照手指移动），往上不动
    setOffset(drag.dy > 0 ? drag.dy : 0);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { samples } = drag;
    const dy = e.clientY - drag.y0;
    drag = null;
    panel.classList.remove('is-dragging');
    // 速度：只看放手前 VELOCITY_WINDOW 内的移动；最后一次移动离放手超过 VELOCITY_STALE（停住再放手）就当 0
    const end = { t: e.timeStamp, y: e.clientY };
    const recent = [...samples.filter((p) => end.t - p.t <= VELOCITY_WINDOW), end];
    const last = samples[samples.length - 1];
    const fresh = end.t - last.t <= VELOCITY_STALE;
    const a = recent[0];
    const b = recent.length > 2 ? recent[recent.length - 2] : end; // 最后一次移动（放手点通常不再移动）
    const v = fresh && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
    const shouldDismiss = e.type === 'pointerup' && dy > 0
      && (dy > panel.offsetHeight * DISMISS_RATIO || (dy >= VELOCITY_MIN_DRAG && v > DISMISS_VELOCITY));
    if (shouldDismiss) requestDismiss();
    if (!closed) setOffset(0); // 弹回（transition）
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  const handle = pushLayer({
    element: overlay,
    onDismiss: requestDismiss,
    onClose: () => {
      closed = true;
      if (vv) {
        vv.removeEventListener('resize', onViewport);
        vv.removeEventListener('scroll', onViewport);
      }
      // 登记退场：首页等它播完（overlay 被移除）才重画、播动画。
      // 减弱动态也一样等（遮罩仍有 0.2s 淡出）：太早放行会让首页在焦点还原之前重画
      const release = trackExit();
      drag = null;   // 关闭中不再被下拉手势写回位移
      overlay.classList.remove('is-visible');
      panel.classList.remove('is-dragging');
      panel.style.transform = ''; // 从目前（可能已下拉一段）的位置滑下去
      const remove = () => { overlay.remove(); release(); };
      overlay.addEventListener('transitionend', (e) => { if (e.target === overlay) remove(); });
      setTimeout(remove, 350); // 后备
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
      if (onClosed) onClosed();
    },
  });
  function close() { handle.close(); }

  document.body.append(overlay);
  onViewport();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) overlay.classList.add('is-visible'); }));
  return { close, requestDismiss, overlay, panel, leftButton, rightButton };
}
