// 底部 Tab Bar：mountTabBar(root, { tabs: [{id,label,icon}], onSelect(id) })
import { h } from './dom.js';
import { icon } from './icons.js';

export function mountTabBar(root, { tabs, onSelect, selected = tabs[0].id }) {
  const buttons = new Map();
  const bar = h('nav', { class: 'tabbar', role: 'tablist', 'aria-label': '主选单' },
    tabs.map((t) => {
      const btn = h('button', {
        type: 'button', class: 'tabbar-item', role: 'tab', 'data-tab': t.id,
        id: `tab-${t.id}`, 'aria-controls': `screen-${t.id}`, 'aria-label': t.label,
        on: { click: () => onSelect(t.id) },
      }, icon(t.icon, 26), h('span', { class: 'tabbar-label', 'aria-hidden': 'true' }, t.label));
      buttons.set(t.id, btn);
      return btn;
    }));

  function setSelected(id) {
    for (const [tid, btn] of buttons) {
      const on = tid === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
  }

  // 左右方向键在分页之间移动（tablist 惯例）
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const ids = tabs.map((t) => t.id);
    const cur = ids.indexOf(document.activeElement?.dataset?.tab);
    if (cur === -1) return;
    const next = ids[(cur + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    buttons.get(next).focus();
    onSelect(next);
  });

  setSelected(selected);
  root.append(bar);
  return { setSelected, element: bar };
}
