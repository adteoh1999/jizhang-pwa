// 进入点：开 DB → 建 store → init → 读登录状态：没登录 → 登录页（2d）；有 → 挂载 Tab Bar 与三个分页 → 安装提示。
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
import { onLedgerResetElsewhere, onPulledElsewhere, announcePulled } from './ledger-channel.js';
import { mountLogin } from './ui/login.js';
import { loadSession, bootTarget, getValidSession } from './auth.js';
import { createRealtime } from './realtime.js';
import { showToast, whenToastIdle } from './ui/toast.js';
import { initAnnouncer } from './ui/announce.js';
import { onUpdateAvailable, markUpdateAvailable, applyUpdate } from './update.js';
import { createSync, ensureClaimed, createClaimRunner } from './sync.js';
import { askSyncStart } from './ui/sync-prompt.js';
import { messageDialog } from './ui/dialogs.js';
import { APP_VERSION } from './version.js';
import { animate, fade, cancelAnims, reducedMotion, clipSupported, DUR, EASE_OUT } from './ui/motion.js';

const TABS = [
  { id: 'home', label: '首页', icon: 'tab-home', title: '记账', aside: true }, // aside：大标题右侧的当月
  { id: 'stats', label: '统计', icon: 'tab-stats', title: '统计' },
  { id: 'settings', label: '设置', icon: 'tab-settings', title: '设置' },
];

// 同步引擎在这些状态时，Realtime 不连线（登录过期、换了账号、账本不是这个账号的、还没开始同步、已停止）
const REALTIME_BLOCKED = new Set(['signed-out', 'stale', 'other-owner', 'unclaimed', 'stopped']);

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
  showBlockingNotice('请重新整理', '以继续使用。');
}

/** 别的分页换账号、登出或删号清除了账本（复审 6：写清楚原因；2f M5 文案改通用）。 */
export function showLedgerChangedNotice() {
  showBlockingNotice('这台设备的账本已清除或换了账号，', '请重新整理。');
}

// tail：句尾整组换行（窄的对话框里「理。」不会单独落到下一行）
function showBlockingNotice(head, tail) {
  if (document.querySelector('[data-db-closed]')) return;
  window.dispatchEvent(new Event('jizhang:blocked')); // 停掉同步与 Realtime（这个画面只能重新整理）
  for (const el of document.body.children) el.inert = true;
  const btn = h('button', {
    type: 'button', class: 'alert-button is-bold', on: { click: () => location.reload() },
  }, '重新整理');
  const panel = h('div', {
    class: 'alert', role: 'alertdialog', 'aria-modal': 'true',
    'aria-labelledby': 'db-closed-title', 'aria-describedby': 'db-closed-msg',
  },
  h('div', { class: 'alert-body' },
    h('h2', { class: 'alert-title', id: 'db-closed-title' }, '需要重新载入'),
    h('p', { class: 'alert-message', id: 'db-closed-msg' }, head, h('span', { class: 'nowrap' }, tail))),
  h('div', { class: 'alert-buttons' }, btn));
  const overlay = h('div', { class: 'overlay overlay-alert overlay-blocking is-visible', 'data-db-closed': '' }, panel);
  document.body.append(overlay);
  btn.focus({ preventScroll: true });
}

function mountShell(root, store, session) {
  const hintSlot = h('div', { class: 'hint-slot' });
  const screens = new Map();
  const scrollPos = new Map(); // 每个分页各自记住滚动位置（只在记忆体）
  let active = TABS[0].id;

  const main = h('main', { class: 'screens' }, TABS.map((t) => {
    const s = h('section', {
      'data-screen': t.id, id: `screen-${t.id}`, role: 'tabpanel', 'aria-labelledby': `tab-${t.id}`,
      class: 'screen', hidden: t.id !== active,
    },
    t.aside
      ? h('div', { class: 'large-title-row' },
        h('h1', { class: 'large-title' }, t.title), h('span', { class: 'large-title-aside' }))
      : h('h1', { class: 'large-title' }, t.title),
    h('div', { class: 'screen-content' }));
    screens.set(t.id, s);
    return s;
  }));

  const shell = h('div', { class: 'shell' }, hintSlot, main);
  root.replaceChildren(shell);

  // 同步（2e）：背景上传；账本还没归属时先问一次（用户决定 3）。引擎与认领在 mountShell 最后才开始。
  const sync = createSync({
    store, fetchFn: (url, init) => fetch(url, init), userId: session.user_id, appVersion: APP_VERSION, onPulled: announcePulled,
  });
  let userStarted = false; // 这次是不是用户自己按了「开始同步」
  const runClaim = createClaimRunner({
    ensure: (fromUser) => {
      userStarted = fromUser;
      return ensureClaimed(store, session, {
        ask: async (n) => { const a = await askSyncStart(store, n); userStarted = userStarted || a === 'start'; return a; },
        fromUser,
      });
    },
    onMine: () => { sync.syncNow(); }, // claim 不触发 onLocalWrite：自己跑一轮（设置页也会马上更新）
    onError: (e) => {
      console.warn(`[sync] 认领失败：${e && e.name ? e.name : '未知'}`);
      // 只有用户自己按过才提示；自动路径不在开 App 时弹窗（设置页会显示「尚未开始同步 · 开始」）
      if (userStarted) messageDialog({ title: '没能开始同步', message: '请稍后再试一次。' });
    },
  });

  const home = screens.get('home');
  mountHome(home.querySelector('.screen-content'), store, { monthEl: home.querySelector('.large-title-aside') });
  const stats = mountStats(screens.get('stats').querySelector('.screen-content'), store);
  // Realtime 门铃（2e-3）：服务器上自己的资料有改动 → 跑一轮同步。同步引擎在这些状态时不连
  const realtime = createRealtime({
    userId: session.user_id,
    getSession: (failedToken) => getValidSession(store, (url, init) => fetch(url, init), { failedToken }),
    onPoke: () => sync.schedule(),
    allowed: () => !REALTIME_BLOCKED.has(sync.status().state),
  });
  sync.subscribe(() => realtime.check()); // sync.stop() 也会最后通知一次（登出、重新登录）
  window.addEventListener('jizhang:blocked', () => { realtime.stop(); sync.stop(); }, { once: true });
  const settings = mountSettings(screens.get('settings').querySelector('.screen-content'), store, {
    session, sync, realtime, onStartSync: () => runClaim(true),
  });

  const tabbar = mountTabBar(root, {
    tabs: TABS,
    selected: active,
    onSelect(id) {
      if (id === active) {
        // 再按一次目前的分页：滚回顶端（iOS 惯例）
        window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
        return;
      }
      scrollPos.set(active, window.scrollY);
      const ids = TABS.map((t) => t.id);
      const dir = ids.indexOf(id) > ids.indexOf(active) ? 1 : -1;   // 往右的分页从右边来
      // 只取消分页切换自己的动画（id 'tab'），不碰列表删除滑出等其他动画
      for (const s of screens.values()) cancelAnims(s, { id: 'tab' });
      screens.get(active).hidden = true;
      const next = screens.get(id);
      next.hidden = false;
      active = id;
      tabbar.setSelected(id);
      window.scrollTo(0, scrollPos.get(id) || 0);
      // v2.3：新分页淡入＋轻微横向滑动（只能横向：首页的 FLIP 量的是 top）。
      // 减弱动态、或不支援 overflow-x: clip（iOS < 16，滑动时会出现横向滚动）→ 只淡入
      if (reducedMotion() || !clipSupported()) fade(next, 'in', { id: 'tab' });
      else {
        animate(next, [{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: 'none' }],
          { duration: DUR.tab, easing: EASE_OUT, id: 'tab' });
      }
      if (id === 'stats') stats.enter();
      if (id === 'settings') settings.enter(); // 站主判断（最多一天问一次服务器，S16）
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

  // 画面都挂好了才开始同步、才问认领（前面任何一步丢错，就不会在错误画面上跑）
  sync.start();
  realtime.start();
  runClaim(false);
  settings.enter(); // 站主判断：启动时、回前景时（S16）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settings.enter(); });
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

    // 已有 toast（例如「已删除 · 撤销」）时不抢掉它，等它消失后再显示。
    // 更新 toast 之后被别的 toast 取代是故意的：设置页「版本」行是常驻入口。onUpdateAvailable 只会通知一次，所以最多排队一次。
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
  document.body.prepend(h('div', { class: 'sky', 'aria-hidden': 'true' }));
  initAnnouncer(); // 读屏朗读区：先放好，之后才念得出来
  window.addEventListener('jizhang:db-versionchange', showDbClosedNotice);
  try {
    // 开发用：只在本机网址上，?simulateDbError=1 模拟开库失败
    if (isDevHost() && new URLSearchParams(location.search).has('simulateDbError')) {
      throw new Error('（模拟）IndexedDB 已停用');
    }
    const db = await openDatabase();
    const store = createStore({ db });
    await store.init();
    // 别的分页换账号清除了账本：这个分页的画面与快取都旧了 → 阻挡画面、请重新整理（审核 M-2）
    store.onLedgerChanged(showLedgerChangedNotice);
    onLedgerResetElsewhere(showLedgerChangedNotice);
    // 别的分页拉回了别台设备的改动：这个分页的快取重新从资料库读（不然要刷新才看得到）
    store.onLocalWrite(announcePulled); // 这个分页自己记账：其他分页也重新载入（游标会被这边推过去，复审 S5）
    onPulledElsewhere(() => { store.reloadFromDb().catch((e) => console.warn(`[sync] 重新载入失败：${e && e.name ? e.name : '未知'}`)); });
    if (isDevHost()) window.__store = store;
    const session = await loadSession(store);
    if (bootTarget(session) === 'login') {
      mountLogin(root, {
        store,
        fetchFn: (url, init) => fetch(url, init),
        onSignedIn: (s) => {
          window.scrollTo(0, 0); // 键盘曾让页面滚动过：首页从顶端开始
          try {
            mountShell(root, store, s);
          } catch (err) {
            console.error(err);
            renderDbError(root, err); // 不要留白屏：显示「重新整理」
            return;
          }
          // 登录成功：焦点移到首页大标题（读屏从这里开始念）
          const title = root.querySelector('.large-title');
          if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
        },
      });
    } else {
      mountShell(root, store, session);
    }
  } catch (err) {
    console.warn('boot failed:', err);
    renderDbError(root, err);
  }
}

boot().then(() => registerServiceWorker());
