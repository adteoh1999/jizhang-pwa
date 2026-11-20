// 底部提示：一次只显示一个（新的取代旧的），位于 Tab Bar 上方。
// duration: Infinity → 一直显示，直到按下动作或被取代。
import { h } from './dom.js';
import { depth, onDepthChange } from './nav.js';

let current = null; // { el, timer }
const idleQueue = [];

/** 等到没有 toast 时呼叫一次 fn（现在就空闲则立刻呼叫）。被别的 toast 取代时不算「空闲」，只在 toast 自然结束 / 被按下 / close() 后才轮到。 */
export function whenToastIdle(fn) {
  if (!current) fn(); else idleQueue.push(fn);
}

// 非同步（微任务）逐个放行；每次放行前重新确认没有 toast，有就留在队列里继续等。
function flushIdle() {
  queueMicrotask(() => {
    while (idleQueue.length && !current) idleQueue.shift()();
  });
}

// 有浮层时 toast 被遮罩盖住，也不可操作
onDepthChange((d) => { if (current) current.el.inert = d > 0; });

/** replaced=true：正被新 toast 取代，不通知等待者。 */
function dismiss(t, replaced = false) {
  if (!t || t.gone) return;
  t.gone = true;
  clearTimeout(t.timer);
  if (current === t) {
    current = null;
    document.body.classList.remove('has-toast');
    if (!replaced) flushIdle();
  }
  t.el.classList.remove('is-visible');
  const remove = () => t.el.remove();
  t.el.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 400); // 后备：reduced motion 或没有 transition
}

export function showToast(message, { actionLabel, onAction, duration = 4000 } = {}) {
  dismiss(current, true);
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
  t.el.inert = depth() > 0;
  document.body.append(t.el);
  current = t;
  document.body.classList.add('has-toast');
  // 下一帧加 class 才有进场动画
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!t.gone) t.el.classList.add('is-visible'); }));
  if (Number.isFinite(duration)) t.timer = setTimeout(() => dismiss(t), duration);
  return { close: () => dismiss(t) };
}
