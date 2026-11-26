// Telegram Mini App 的外观与手感（3c-2）：主题跟 Telegram、顶栏／底色、禁竖向滑动、全屏安全区、返回键、震动。
// 模块级单例：只有 installTgChrome() 装上之后才做事；PWA 不装 → 所有导出都不做事（零影响）。
// 不 import 任何 ui/*：浮层栈（nav.js）由 app.js 注入，避免循环依赖。
// 官方资料（core.telegram.org/bots/webapps，2026-11-26 查证）：setBackgroundColor／BackButton／HapticFeedback 6.1+；
// setHeaderColor 自订 #RRGGBB 要 7.0+（6.9 以前只能用主题色）；disableVerticalSwipes 7.7+；安全区与其事件 8.0+。
// 文件没写呼叫不支援的方法会怎样 → 先查版本，每个呼叫再各自包 try/catch。这里的函数都不会 throw。

// 要等于 css/app.css 的 --sky-top（浅色 :root、两块深色；tests/tg-chrome 检查）
export const TG_SKY_TOP = { light: '#CFE3EF', dark: '#132230' };
const INSET_MAX = 200;
const SIDES = ['top', 'right', 'bottom', 'left'];

export const themeOf = (scheme) => (scheme === 'dark' ? 'dark' : 'light');

/** 安全区数值 → CSS 长度字串；0／不合格 → null（移除属性）。上限 200px。 */
export function insetPx(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(Math.min(n, INSET_MAX) * 100) / 100}px`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const attempt = (fn) => { try { fn(); } catch { /* 这个版本或平台不支援：忽略 */ } };

let st = null; // 装上之后的状态
let pageBack = null; // 登录页（邮箱／验证码）给的返回；没装也记着，装上后照样生效

function backWanted() {
  if (!st || st.blocked) return false;
  try {
    if (st.nav.depth() > 0) return st.nav.canPop() === true;
  } catch { return false; }
  return !!pageBack;
}

// 显示立即做；隐藏延后一帧（连续对话框之间 depth 会短暂变 0，不要在「返回／关闭」之间闪）
function syncBack() {
  if (!st || !st.caps.back) return;
  if (backWanted()) {
    st.hidePending = false;
    if (st.backShown !== true) { st.backShown = true; attempt(() => st.wa.BackButton.show()); }
    return;
  }
  if (st.backShown === false || st.hidePending) return;
  st.hidePending = true;
  const me = st;
  me.defer(() => {
    if (st !== me || !me.hidePending) return;
    me.hidePending = false; // 这一帧内又想显示的话，syncBack 已经把 hidePending 清掉、走不到这里
    me.backShown = false;
    attempt(() => me.wa.BackButton.hide());
  });
}

// 按下时再判断一次（hide 经过桥接不是即时的，迟到的点击不能误关阻挡画面底下的东西）
function onBackClick() {
  if (!st || st.blocked) return;
  try {
    if (st.nav.depth() > 0) { if (st.nav.canPop()) st.nav.popLayer(); return; }
  } catch (e) { console.error(e); return; }
  if (pageBack) { try { pageBack(); } catch (e) { console.error(e); } }
}

// webApp 的栏位一律在 try 里读（getter 丢错当没有）
function read(key) {
  try { return st.wa[key]; } catch { return undefined; }
}

function applyTheme() {
  const scheme = themeOf(read('colorScheme'));
  if (scheme === st.scheme) return; // 颜色只跟深浅有关：没变就跳过
  st.scheme = scheme;
  st.root.dataset.theme = scheme;
  const color = TG_SKY_TOP[scheme];
  if (st.caps.bg) attempt(() => st.wa.setBackgroundColor(color));
  if (st.caps.header) attempt(() => st.wa.setHeaderColor(color));
}

// 只在全屏时躲开系统＋Telegram 的按钮（非全屏时画面在 Telegram 顶栏下面，3b 真机已验，不动）
function applyInsets() {
  const full = read('isFullscreen') === true;
  const safe = read('safeAreaInset');
  const content = read('contentSafeAreaInset');
  for (const side of SIDES) {
    const px = full ? insetPx(num(safe?.[side]) + num(content?.[side])) : null;
    if (px === st.insets[side]) continue; // 没变不写（改 :root 自订属性会整页重算样式）
    st.insets[side] = px;
    const name = `--jz-inset-${side}`;
    attempt(() => { if (px) st.root.style.setProperty(name, px); else st.root.style.removeProperty(name); });
  }
}

/**
 * 装上（只在 Telegram 模式、SDK 载完时呼叫一次）。第二次以后直接忽略、回 false。
 * nav：{ depth, canPop, popLayer, onDepthChange }（js/ui/nav.js）。
 */
export function installTgChrome(webApp, {
  root = globalThis.document?.documentElement, win = globalThis.window, nav,
  defer = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)),
} = {}) {
  if (st || !webApp || typeof webApp !== 'object' || !root || !nav) return false;
  const at = (v) => { try { return typeof webApp.isVersionAtLeast === 'function' && webApp.isVersionAtLeast(v) === true; } catch { return false; } };
  st = {
    wa: webApp, root, nav, defer, blocked: false, scheme: null, insets: {}, backShown: null, hidePending: false, offs: [],
    caps: { bg: at('6.1'), back: at('6.1'), haptic: at('6.1'), header: at('7.0'), swipe: at('7.7'), inset: at('8.0') },
  };
  const on = (name, fn) => attempt(() => webApp.onEvent(name, () => { if (st && st.wa === webApp) attempt(fn); }));
  try {
    wireUp(webApp, win, on);
  } catch { /* 装到一半出意外：已经设好的照用，绝不让启动变成错误画面（审核建议 3） */ }
  return true;
}

function wireUp(webApp, win, on) {
  const { nav } = st;
  attempt(applyTheme);
  on('themeChanged', applyTheme);

  if (st.caps.swipe) attempt(() => webApp.disableVerticalSwipes());

  if (st.caps.inset) {
    attempt(applyInsets);
    for (const ev of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged']) on(ev, applyInsets);
  }

  if (st.caps.back) {
    st.backShown = false;
    attempt(() => webApp.BackButton.hide()); // 不假设一开始是隐藏的（例如换版自动重载前开着 sheet）
    attempt(() => webApp.BackButton.onClick(() => { if (st && st.wa === webApp) onBackClick(); }));
    try { st.offs.push(nav.onDepthChange(() => syncBack())); } catch { /* 忽略 */ }
    if (win && typeof win.addEventListener === 'function') {
      // 阻挡画面：事件先派、节点后插，所以不查 DOM，收到就记住（只能重新整理离开）
      const onBlocked = () => { if (st) { st.blocked = true; syncBack(); } };
      win.addEventListener('jizhang:blocked', onBlocked);
      st.offs.push(() => win.removeEventListener('jizhang:blocked', onBlocked));
    }
    syncBack();
  }
}

/**
 * 现在是不是 Telegram 模式（已装上）。export-csv.js 靠它决定「绝不走下载」：
 * Telegram 模式下 installTgChrome 一定要设好 st（不能因为某个条件回 false 而没装）。
 */
export const tgActive = () => st !== null;

/** 登录页（邮箱／验证码步骤）给 Telegram 返回键用的处理函数。 */
export function setPageBack(fn) {
  pageBack = typeof fn === 'function' ? fn : null;
  syncBack();
}

/** 只清掉自己注册的那个（新旧登录页交错时不清到别人的）。 */
export function clearPageBack(fn) {
  if (pageBack !== fn) return;
  pageBack = null;
  syncBack();
}

// 没有原型的物件：'constructor'、'toString' 之类的键查不到（不用 Object.hasOwn：旧 WebView 没有，审核必须改 1）
const HAPTIC = Object.assign(Object.create(null), {
  light: (h) => h.impactOccurred('light'),
  selection: (h) => h.selectionChanged(),
  success: (h) => h.notificationOccurred('success'),
  error: (h) => h.notificationOccurred('error'),
});

/** 震动：'light' | 'selection' | 'success' | 'error'。没装、版本不够、不认得的种类 → 不做事。绝不丢错（呼叫处在储存流程中间）。 */
export function haptic(kind) {
  try {
    if (!st || !st.caps.haptic || typeof kind !== 'string') return;
    const fn = HAPTIC[kind];
    if (typeof fn === 'function') fn(st.wa.HapticFeedback);
  } catch { /* 这个版本或平台不支援：忽略 */ }
}

/** 测试用：拆掉单例（解除监听），下一个测试才能重新装。 */
export function _resetTgChrome() {
  if (st) for (const off of st.offs) attempt(off);
  st = null;
  pageBack = null;
}
