// 进入点：开 DB → 建 store → init → 挂载 Tab Bar 与三个分页 → 安装提示。
// 最后注册 Service Worker（离线 + 更新提示）。
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { h } from './ui/dom.js';
import { mountTabBar } from './ui/tabbar.js';
import { onDepthChange } from './ui/nav.js';
import { maybeShowInstallHint } from './ui/install-hint.js';
import { mountHome } from './ui/home.js';
import { mountStats } from './ui/stats-view.js';
import { mountSettings } from './ui/settings.js';
import { showToast, whenToastIdle } from './ui/toast.js';
import { onUpdateAvailable, markUpdateAvailable, applyUpdate } from './update.js';

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

/** 资料库被其他分页升级 / 删除：连线已关闭，写入会失败 → 不可关闭的阻挡画面（不入 nav 栈，Esc 关不掉）。 */
export function showDbClosedNotice() {
  if (document.querySelector('[data-db-closed]')) return;
  for (const el of document.body.children) el.inert = true;
  const btn = h('button', {
    type: 'button', class: 'alert-button is-bold', on: { click: () => location.reload() },
  }, '重新整理');
  const panel = h('div', {
    class: 'alert', role: 'alertdialog', 'aria-modal': 'true',
    'aria-labelledby': 'db-closed-title', 'aria-describedby': 'db-closed-msg',
  },
  h('div', { class: 'alert-body' },
    h('h2', { class: 'alert-title', id: 'db-closed-title' }, '资料库已更新'),
    h('p', { class: 'alert-message', id: 'db-closed-msg' }, '资料库已在其他地方更新，请重新整理后继续使用。')),
  h('div', { class: 'alert-buttons' }, btn));
  const overlay = h('div', { class: 'overlay overlay-alert overlay-blocking is-visible', 'data-db-closed': '' }, panel);
  document.body.append(overlay);
  btn.focus({ preventScroll: true });
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
  mountHome(screens.get('home').querySelector('.screen-content'), store);
  mountStats(screens.get('stats').querySelector('.screen-content'), store);
  mountSettings(screens.get('settings').querySelector('.screen-content'), store);

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
    const off = d > 0 || !!document.querySelector('[data-db-closed]'); // 阻挡画面在时保持不可操作
    shell.inert = off;
    tabbar.element.inert = off;
    document.documentElement.classList.toggle('has-layer', d > 0);
  });

  maybeShowInstallHint(hintSlot, store).catch((e) => console.error(e));
}

/** 注册 Service Worker；本机网址默认不注册（方便开发），加 ?sw=1 才注册。失败只 warn，不影响 App。 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (isDevHost() && new URLSearchParams(location.search).get('sw') !== '1') return;
  try {
    const sw = navigator.serviceWorker;
    let lastController = sw.controller; // 首次安装的 claim（之前没有 controller）不重载
    let reloaded = false;
    sw.addEventListener('controllerchange', () => {
      const hadController = lastController !== null;
      lastController = sw.controller;
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });

    // 已有 toast（例如「已删除 · 撤销」）时不抢掉它，等它消失后再显示
    onUpdateAvailable(() => whenToastIdle(() => showToast('有新版本', {
      actionLabel: '更新', duration: Infinity, onAction: applyUpdate,
    })));

    const reg = await sw.register('sw.js', { scope: './' });
    const watch = (w) => w.addEventListener('statechange', () => {
      if (w.state === 'installed' && sw.controller) markUpdateAvailable(reg, w);
    });
    if (reg.waiting && sw.controller) markUpdateAvailable(reg, reg.waiting);
    if (reg.installing) watch(reg.installing);
    reg.addEventListener('updatefound', () => { if (reg.installing) watch(reg.installing); });
  } catch (err) {
    console.warn('Service Worker 注册失败:', err);
  }
}

async function boot() {
  const root = document.getElementById('app');
  window.addEventListener('jizhang:db-versionchange', showDbClosedNotice);
  try {
    // 开发用：只在本机网址上，?simulateDbError=1 模拟开库失败
    if (isDevHost() && new URLSearchParams(location.search).has('simulateDbError')) {
      throw new Error('（模拟）IndexedDB 已停用');
    }
    const db = await openDatabase();
    const store = createStore({ db });
    await store.init();
    if (isDevHost()) window.__store = store;
    mountShell(root, store);
  } catch (err) {
    console.warn('boot failed:', err);
    renderDbError(root, err);
  }
}

boot().then(() => registerServiceWorker());
