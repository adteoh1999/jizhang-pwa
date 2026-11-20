// 底部提示：一次只显示一个（新的取代旧的），位于 Tab Bar 上方。
// duration: Infinity → 一直显示，直到按下动作或被取代。
import { h } from './dom.js';

let current = null; // { el, timer }

function dismiss(t) {
  if (!t || t.gone) return;
  t.gone = true;
  clearTimeout(t.timer);
  if (current === t) current = null;
  t.el.classList.remove('is-visible');
  const remove = () => t.el.remove();
  t.el.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 400); // 后备：reduced motion 或没有 transition
}

export function showToast(message, { actionLabel, onAction, duration = 4000 } = {}) {
  dismiss(current);
  const t = { gone: false, timer: 0, el: null };
  const action = actionLabel
    ? h('button', {
      type: 'button', class: 'toast-action pressable',
      on: {
        click: () => {
          dismiss(t);
          if (onAction) onAction();
        },
      },
    }, actionLabel)
    : null;
  t.el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'toast-message' }, message), action);
  document.body.append(t.el);
  current = t;
  // 下一帧加 class 才有进场动画
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!t.gone) t.el.classList.add('is-visible'); }));
  if (Number.isFinite(duration)) t.timer = setTimeout(() => dismiss(t), duration);
  return { close: () => dismiss(t) };
}
