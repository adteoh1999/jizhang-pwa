// 进入点：开 DB → 建 store → init → 挂载 Tab Bar 与三个分页 → 安装提示。
// Service Worker 在 Task 13 才注册。
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { h } from './ui/dom.js';
import { mountTabBar } from './ui/tabbar.js';
import { onDepthChange } from './ui/nav.js';
import { showToast } from './ui/toast.js';
import { maybeShowInstallHint } from './ui/install-hint.js';

const TABS = [
  { id: 'home', label: '首页', icon: 'house', title: '记账' },
  { id: 'stats', label: '统计', icon: 'chart', title: '统计' },
  { id: 'settings', label: '设置', icon: 'gear', title: '设置' },
];

const isDevHost = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/** 开库失败的全屏画面。 */
export function renderDbError(root, err) {
  root.replaceChildren(h('div', { class: 'fatal', role: 'alert' },
    h('h1', { class: 'fatal-title' }, '无法开启资料库'),
    h('p', { class: 'fatal-message' }, (err && err.message) || String(err || '未知错误')),
    h('button', {
      type: 'button', class: 'fatal-button pressable', on: { click: () => location.reload() },
    }, '重新整理')));
}

function mountShell(root, store) {
  const hintSlot = h('div', { class: 'hint-slot' });
  const screens = new Map();
  const scrollPos = new Map(); // 每个分页各自记住捲动位置（只在记忆体）
  let active = TABS[0].id;

  const main = h('main', { class: 'screens' }, TABS.map((t) => {
    const s = h('section', {
      'data-screen': t.id, id: `screen-${t.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`,
      class: 'screen', hidden: t.id !== active,
    },
    h('header', { class: 'nav-bar' }),
    h('h1', { class: 'large-title' }, t.title),
    h('div', { class: 'screen-content' }));
    screens.set(t.id, s);
    return s;
  }));

  const shell = h('div', { class: 'shell' }, hintSlot, main);
  root.replaceChildren(shell);

  const tabbar = mountTabBar(root, {
    tabs: TABS,
    selected: active,
    onSelect(id) {
      if (id === active) {
        // 再按一次目前的分页：捲回顶端（iOS 惯例）
        window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return;
      }
      scrollPos.set(active, window.scrollY);
      screens.get(active).hidden = true;
      screens.get(id).hidden = false;
      active = id;
      tabbar.setSelected(id);
      window.scrollTo(0, scrollPos.get(id) || 0);
    },
  });

  // 有浮层时，底下的画面不可操作（VoiceOver 也不会读到）
  onDepthChange((d) => {
    shell.inert = d > 0;
    tabbar.element.inert = d > 0;
    document.documentElement.classList.toggle('has-layer', d > 0);
  });

  maybeShowInstallHint(hintSlot, store).catch((e) => console.error(e));
}

async function boot() {
  const root = document.getElementById('app');
  window.addEventListener('jizhang:db-versionchange', () => {
    showToast('资料库已更新，请重新整理', {
      actionLabel: '重新整理', onAction: () => location.reload(), duration: Infinity,
    });
  });
  let store;
  try {
    // 开发用：只在本机网址上，?simulateDbError=1 模拟开库失败
    if (isDevHost() && new URLSearchParams(location.search).has('simulateDbError')) {
      throw new Error('（模拟）IndexedDB 已停用');
    }
    const db = await openDatabase();
    store = createStore({ db });
    await store.init();
  } catch (err) {
    console.warn('openDatabase/init failed:', err);
    renderDbError(root, err);
    return;
  }
  if (isDevHost()) window.__store = store;
  mountShell(root, store);
}

boot();
