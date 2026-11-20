// 共用小元件：支出/收入分段控件、「放弃这次修改？」确认。
import { h } from './dom.js';
import { actionSheet } from './dialogs.js';

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
    onChange(v);
  }
  sync();
  return {
    element,
    set(v) { current = v; sync(); },
  };
}

/** 「放弃这次修改？」action sheet；按「放弃修改」→ true，取消 / Esc / 点背景 → false。 */
export async function confirmDiscard() {
  const choice = await actionSheet({
    title: '放弃这次修改？',
    actions: [{ label: '放弃修改', style: 'destructive' }, { label: '取消', style: 'cancel' }],
  });
  return choice === '放弃修改';
}
