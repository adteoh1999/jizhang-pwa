// 共用小元件：支出/收入分段控件、「放弃这次修改？」确认。
import { h } from './dom.js';
import { actionSheet } from './dialogs.js';
import { haptic } from '../tg-chrome.js';

const KINDS = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
];

/**
 * 支出 / 收入分段控件（role=radiogroup / radio；方向键切换；data-selected 给 CSS 滑动底块）。
 * kindSegmented({ value, onChange, label = '类型' }) → { element, set(value) }
 * 使用者点按 / 方向键改变时呼叫 onChange(newValue)；set() 只更新显示，不呼叫 onChange。
 */
export function kindSegmented({ value, onChange, label = '类型' }) {
  let current = value;
  const buttons = KINDS.map((k) => h('button', {
    type: 'button', role: 'radio', class: 'segment', 'data-kind': k.id,
    on: { click: () => change(k.id) },
  }, k.label));
  const element = h('div', {
    class: 'segmented', role: 'radiogroup', 'aria-label': label,
    on: {
      keydown: (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = current === 'expense' ? 'income' : 'expense';
        change(next);
        buttons.find((b) => b.dataset.kind === next).focus();
      },
    },
  }, buttons);

  function sync() {
    for (const b of buttons) {
      const on = b.dataset.kind === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    element.dataset.selected = current; // CSS 用来滑动选中的底块
  }
  function change(v) {
    if (v === current) return;
    current = v;
    sync();
    haptic('selection'); // Telegram 里：选择改变（HIG selection；PWA 不做事）
    onChange(v);
  }
  sync();
  return {
    element,
    set(v) { current = v; sync(); },
  };
}

/** 多选项分段控件的方向键：右／下下一个、左／上上一个，两端绕回；其他键不动。 */
export function segmentStep(index, key, n) {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + n) % n;
  return index;
}

/**
 * 2–4 个选项的分段控件（邀请码有效期用；外观同 kindSegmented，CSS 用 --n / --i 算底块宽度与位置）。
 * optionSegmented({ options: [{id, label}], value, onChange, label }) → { element, value() }
 */
export function optionSegmented({ options, value, onChange, label }) {
  let current = options.findIndex((o) => o.id === value);
  if (current < 0) current = 0;
  const buttons = options.map((o, i) => h('button', {
    type: 'button', role: 'radio', class: 'segment', on: { click: () => change(i) },
  }, o.label));
  const element = h('div', {
    class: 'segmented is-multi', role: 'radiogroup', 'aria-label': label,
    on: {
      keydown: (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = segmentStep(current, e.key, options.length);
        change(next);
        buttons[next].focus();
      },
    },
  }, buttons);
  element.style.setProperty('--n', String(options.length));
  function sync() {
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', i === current ? 'true' : 'false');
      b.tabIndex = i === current ? 0 : -1;
    });
    element.style.setProperty('--i', String(current));
  }
  function change(i) {
    if (i === current) return;
    current = i;
    sync();
    haptic('selection');
    onChange(options[i].id);
  }
  sync();
  return { element, value: () => options[current].id };
}

/** 「放弃这次修改？」action sheet；按「放弃修改」→ true，取消 / Esc / 点背景 → false。 */
export async function confirmDiscard() {
  const choice = await actionSheet({
    title: '放弃这次修改？',
    actions: [{ label: '放弃修改', style: 'destructive' }, { label: '取消', style: 'cancel' }],
  });
  return choice === '放弃修改';
}
