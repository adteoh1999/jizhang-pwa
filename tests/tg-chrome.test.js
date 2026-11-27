// 3c-2：Telegram 外观与手感（js/tg-chrome.js）。全部用假的 webApp／根元素；nav 用真的 nav.js。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  installTgChrome, setPageBack, clearPageBack, haptic, themeOf, insetPx, TG_SKY_TOP, _resetTgChrome, tgActive,
} from '../js/tg-chrome.js';
import { pushLayer, popLayer, depth, canPop, onDepthChange } from '../js/ui/nav.js';
import { light, mediaDark, attrDark } from './helpers/css-tokens.js';

const NAV = { depth, canPop, popLayer, onDepthChange };

function cmp(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function fakeWa({ version = '8.0', colorScheme = 'light', isFullscreen = false, safe, content, throwAll = false } = {}) {
  const calls = [];
  const handlers = {};
  const backClicks = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); if (throwAll) throw new Error('unsupported'); };
  const wa = {
    version, colorScheme, isFullscreen,
    safeAreaInset: safe ?? { top: 0, right: 0, bottom: 0, left: 0 },
    contentSafeAreaInset: content ?? { top: 0, right: 0, bottom: 0, left: 0 },
    isVersionAtLeast: (v) => cmp(version, v) >= 0,
    setHeaderColor: rec('header'),
    setBackgroundColor: rec('bg'),
    setBottomBarColor: rec('bottom'),
    disableVerticalSwipes: rec('noswipe'),
    onEvent(name, fn) { (handlers[name] ??= []).push(fn); },
    BackButton: { show: rec('show'), hide: rec('hide'), onClick(fn) { backClicks.push(fn); } },
    HapticFeedback: {
      impactOccurred: rec('impact'), notificationOccurred: rec('notify'), selectionChanged: rec('selection'),
    },
  };
  const emit = (name) => { for (const f of handlers[name] ?? []) f(); };
  const clickBack = () => { for (const f of backClicks) f(); };
  return { wa, calls, emit, clickBack, backClicks, handlers };
}

function fakeRoot() {
  const props = new Map();
  return {
    dataset: {},
    props,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) },
  };
}

// 隐藏延后一帧：测试手动执行排队的回调
function fakeDefer() {
  const q = [];
  const defer = (fn) => { q.push(fn); };
  defer.flush = () => { while (q.length) q.shift()(); };
  defer.size = () => q.length;
  return defer;
}

function setup(opts = {}, { nav = NAV } = {}) {
  const f = fakeWa(opts);
  const root = fakeRoot();
  const win = new EventTarget();
  const defer = fakeDefer();
  const ok = installTgChrome(f.wa, { root, win, nav, defer });
  return { ...f, root, win, defer, ok };
}
const names = (calls, n) => calls.filter((c) => c[0] === n);

afterEach(() => {
  _resetTgChrome();
  for (let i = 0; i < 100 && depth() > 0; i += 1) popLayer();
});

// ---------- 纯函数 ----------
test('themeOf：dark → dark；其他一律 light', () => {
  assert.equal(themeOf('dark'), 'dark');
  assert.equal(themeOf('light'), 'light');
  for (const v of [undefined, null, '', 'DARK', 'night', 1]) assert.equal(themeOf(v), 'light');
});

test('TG_SKY_TOP 等于 CSS 的 --sky-top（浅色、两块深色）', () => {
  assert.equal(TG_SKY_TOP.light, light['--sky-top']);
  assert.equal(TG_SKY_TOP.dark, attrDark['--sky-top']);
  assert.equal(TG_SKY_TOP.dark, mediaDark['--sky-top']);
  for (const c of Object.values(TG_SKY_TOP)) assert.match(c, /^#[0-9A-Fa-f]{6}$/);
});

test('insetPx：正数 → 「数字px」；0、负数、NaN、非数字 → null；上限 200', () => {
  assert.equal(insetPx(12), '12px');
  assert.equal(insetPx(12.345), '12.35px');
  assert.equal(insetPx(500), '200px');
  for (const v of [0, -1, NaN, Infinity, -Infinity, '12', null, undefined, {}]) assert.equal(insetPx(v), null, String(v));
});

// ---------- 主题 ----------
test('主题：装上就设 data-theme 与 Telegram 顶栏／底色（8.0）', () => {
  const s = setup({ colorScheme: 'dark' });
  assert.equal(s.ok, true);
  assert.equal(s.root.dataset.theme, 'dark');
  assert.deepEqual(names(s.calls, 'bg'), [['bg', '#0D1412']]);
  assert.deepEqual(names(s.calls, 'header'), [['header', '#0D1412']]);
  assert.equal(names(s.calls, 'bottom').length, 0, '底部条颜色这批不设（审核 S12）');
});

test('主题：themeChanged 换了深浅才重设；深浅没变不重设', () => {
  const s = setup({ colorScheme: 'light' });
  assert.equal(s.root.dataset.theme, 'light');
  s.emit('themeChanged');
  assert.equal(names(s.calls, 'bg').length, 1, '深浅没变：不重设');
  s.wa.colorScheme = 'dark';
  s.emit('themeChanged');
  assert.equal(s.root.dataset.theme, 'dark');
  assert.deepEqual(names(s.calls, 'bg').at(-1), ['bg', '#0D1412']);
  assert.deepEqual(names(s.calls, 'header').at(-1), ['header', '#0D1412']);
});

test('主题：版本 6.0 只设 data-theme；6.1–6.9 只设底色；7.0 起顶栏也设', () => {
  const a = setup({ version: '6.0' });
  assert.equal(a.root.dataset.theme, 'light');
  assert.equal(names(a.calls, 'bg').length + names(a.calls, 'header').length, 0);
  _resetTgChrome();
  const b = setup({ version: '6.9' });
  assert.deepEqual(names(b.calls, 'bg'), [['bg', '#F9F9F7']]);
  assert.equal(names(b.calls, 'header').length, 0, '6.9 以前顶栏只能用主题色：不设');
  _resetTgChrome();
  const c = setup({ version: '7.0' });
  assert.deepEqual(names(c.calls, 'header'), [['header', '#F9F9F7']]);
});

// ---------- 竖向滑动 ----------
test('竖向滑动：7.7 起关掉；7.6 不碰', () => {
  assert.equal(names(setup({ version: '7.6' }).calls, 'noswipe').length, 0);
  _resetTgChrome();
  assert.equal(names(setup({ version: '7.7' }).calls, 'noswipe').length, 1);
});

// ---------- 安全区（审核 S1：四边都只在全屏时写） ----------
test('安全区：非全屏不写任何 --jz-inset-*', () => {
  const s = setup({ safe: { top: 59, right: 0, bottom: 34, left: 0 }, content: { top: 40, right: 0, bottom: 0, left: 0 } });
  assert.equal(s.root.props.size, 0);
});

test('安全区：全屏 → 系统＋内容相加，格式一律「数字px」，0 不写', () => {
  const s = setup({ isFullscreen: true, safe: { top: 59, right: 0, bottom: 34, left: 0 }, content: { top: 46, right: 0, bottom: 0, left: 0 } });
  assert.equal(s.root.props.get('--jz-inset-top'), '105px');
  assert.equal(s.root.props.get('--jz-inset-bottom'), '34px');
  assert.equal(s.root.props.has('--jz-inset-left'), false);
  assert.equal(s.root.props.has('--jz-inset-right'), false);
  for (const v of s.root.props.values()) assert.match(v, /^\d+(\.\d+)?px$/);
});

test('安全区：怪值当 0；离开全屏就移除；事件后重算', () => {
  const s = setup({ isFullscreen: true, safe: { top: 'x', right: -5, bottom: NaN, left: 20 }, content: null });
  assert.deepEqual([...s.root.props], [['--jz-inset-left', '20px']]);
  s.wa.isFullscreen = false;
  s.emit('fullscreenChanged');
  assert.equal(s.root.props.size, 0);
  s.wa.isFullscreen = true;
  s.wa.safeAreaInset = { top: 10, right: 0, bottom: 0, left: 0 };
  s.emit('safeAreaChanged');
  assert.deepEqual([...s.root.props], [['--jz-inset-top', '10px']]);
  s.wa.contentSafeAreaInset = { top: 5, right: 0, bottom: 0, left: 0 };
  s.emit('contentSafeAreaChanged');
  assert.equal(s.root.props.get('--jz-inset-top'), '15px');
});

test('安全区：值没变不重写（避免整页重算样式）', () => {
  const s = setup({ isFullscreen: true, safe: { top: 10, right: 0, bottom: 0, left: 0 } });
  let writes = 0;
  const orig = s.root.style.setProperty;
  s.root.style.setProperty = (k, v) => { writes += 1; orig(k, v); };
  s.emit('safeAreaChanged');
  s.emit('contentSafeAreaChanged');
  assert.equal(writes, 0);
});

test('安全区：8.0 以下不碰、也不监听', () => {
  const s = setup({ version: '7.10', isFullscreen: true, safe: { top: 59, right: 0, bottom: 34, left: 0 } });
  assert.equal(s.root.props.size, 0);
  assert.equal(s.handlers.safeAreaChanged, undefined);
});

// ---------- 返回键 ----------
test('返回键：装上先无条件 hide 一次，只注册一个 onClick', () => {
  const s = setup();
  assert.deepEqual(s.calls.filter((c) => c[0] === 'show' || c[0] === 'hide'), [['hide']]);
  assert.equal(s.backClicks.length, 1);
});

test('返回键：有浮层就显示、按下 = popLayer；浮层关掉后延一帧才隐藏', () => {
  const s = setup();
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  assert.deepEqual(s.calls.at(-1), ['show']);
  s.clickBack();
  assert.equal(closed, 1);
  assert.equal(depth(), 0);
  assert.notDeepEqual(s.calls.at(-1), ['hide'], '还没过一帧');
  s.defer.flush();
  assert.deepEqual(s.calls.at(-1), ['hide']);
});

test('返回键：连续对话框之间 depth 短暂变 0，不会闪（同一帧又有浮层 → 不隐藏）', () => {
  const s = setup();
  const a = pushLayer({});
  a.close();
  pushLayer({});
  s.defer.flush();
  assert.equal(names(s.calls, 'hide').length, 1, '只有安装时那一次');
  assert.equal(names(s.calls, 'show').length, 1, '不重复 show');
});

test('返回键：最上层 locked（「正在…」遮罩）→ 不显示；按了也不做事', () => {
  const s = setup();
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  const lock = pushLayer({ locked: true, onDismiss: () => {} });
  s.defer.flush();
  assert.deepEqual(s.calls.at(-1), ['hide']);
  s.clickBack(); // 迟到的点击
  assert.equal(closed, 0);
  assert.equal(depth(), 2);
  lock.close(); // locked 层 popLayer 关不掉：自己关（afterEach 才清得掉）
  assert.deepEqual(s.calls.at(-1), ['show'], '遮罩关掉、底下的层还在 → 又显示');
});

test('返回键：没有浮层时用登录页给的返回；清掉后隐藏、按了不做事', () => {
  const s = setup();
  let backs = 0;
  const fn = () => { backs += 1; };
  setPageBack(fn);
  assert.deepEqual(s.calls.at(-1), ['show']);
  s.clickBack();
  assert.equal(backs, 1);
  clearPageBack(fn);
  s.defer.flush();
  assert.deepEqual(s.calls.at(-1), ['hide']);
  s.clickBack();
  assert.equal(backs, 1);
});

test('返回键：clearPageBack 只清自己注册的那个', () => {
  const s = setup();
  let which = '';
  const oldFn = () => { which = 'old'; };
  const newFn = () => { which = 'new'; };
  setPageBack(oldFn);
  setPageBack(newFn);
  clearPageBack(oldFn); // 旧登录页晚一步 destroy
  s.clickBack();
  assert.equal(which, 'new');
});

test('返回键：有浮层时按下走 popLayer，不走登录页的返回', () => {
  const s = setup();
  let backs = 0;
  setPageBack(() => { backs += 1; });
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  s.clickBack();
  assert.equal(closed, 1);
  assert.equal(backs, 0);
});

test('返回键：阻挡画面（先派 jizhang:blocked、后插节点）→ 隐藏，之后按了也不做事', () => {
  const s = setup();
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  s.win.dispatchEvent(new Event('jizhang:blocked'));
  s.defer.flush();
  assert.deepEqual(s.calls.at(-1), ['hide']);
  s.clickBack();
  assert.equal(closed, 0);
  pushLayer({}); // 之后再开浮层也不显示
  s.defer.flush();
  assert.deepEqual(s.calls.at(-1), ['hide']);
});

test('返回键：6.0 不碰 BackButton', () => {
  const s = setup({ version: '6.0' });
  assert.equal(s.backClicks.length, 0);
  pushLayer({});
  assert.equal(names(s.calls, 'show').length, 0);
});

// ---------- 震动 ----------
test('震动：照种类呼叫；不认得的种类不做事', () => {
  const s = setup();
  haptic('light');
  haptic('selection');
  haptic('success');
  haptic('error');
  haptic('boom');
  assert.deepEqual(s.calls.filter((c) => ['impact', 'notify', 'selection'].includes(c[0])), [
    ['impact', 'light'], ['selection'], ['notify', 'success'], ['notify', 'error'],
  ]);
});

test('震动：6.0 不叫', () => {
  const s = setup({ version: '6.0' });
  haptic('success');
  assert.equal(names(s.calls, 'notify').length, 0);
});

// ---------- 没装、装两次、丢错 ----------
test('没装：所有导出都不做事、不丢错', () => {
  assert.doesNotThrow(() => {
    haptic('success');
    setPageBack(() => {});
    clearPageBack(() => {});
  });
});

test('装两次：第二次直接忽略（onClick 不会注册两次）', () => {
  const s = setup();
  const again = installTgChrome(s.wa, { root: s.root, win: s.win, nav: NAV, defer: s.defer });
  assert.equal(again, false);
  assert.equal(s.backClicks.length, 1);
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  pushLayer({ onClose: () => { closed += 1; } });
  s.clickBack();
  assert.equal(closed, 1, '按一下只退一层');
});

test('Telegram 方法全部丢错：装得上、之后呼叫也不外泄', () => {
  let s;
  assert.doesNotThrow(() => { s = setup({ throwAll: true, isFullscreen: true, safe: { top: 1, right: 0, bottom: 0, left: 0 } }); });
  assert.equal(s.root.dataset.theme, 'light');
  assert.doesNotThrow(() => {
    pushLayer({});
    s.clickBack();
    s.defer.flush();
    setPageBack(() => {});
    haptic('success');
    s.wa.colorScheme = 'dark';
    s.emit('themeChanged');
  });
  assert.equal(s.root.dataset.theme, 'dark');
});

test('webApp 不合格（null、没有 isVersionAtLeast）：回 false，不做事', () => {
  assert.equal(installTgChrome(null, { root: fakeRoot(), win: new EventTarget(), nav: NAV, defer: fakeDefer() }), false);
  _resetTgChrome();
  const root = fakeRoot();
  assert.doesNotThrow(() => installTgChrome({ colorScheme: 'dark' }, { root, win: new EventTarget(), nav: NAV, defer: fakeDefer() }));
  assert.equal(root.dataset.theme, 'dark', '没有版本函数：至少主题照设（页面自己的事）');
});

test('_resetTgChrome 之后可以重新装（测试之间不共用状态）', () => {
  setup();
  _resetTgChrome();
  const s = setup();
  assert.equal(s.ok, true);
});

// ---------- 代码审核 r1 补充 ----------
test('震动：旧环境没有 Object.hasOwn 也不丢错（审核必须改 1）', () => {
  setup();
  const saved = Object.hasOwn;
  try {
    delete Object.hasOwn;
    assert.doesNotThrow(() => haptic('success'));
    assert.doesNotThrow(() => haptic('constructor'));
    assert.doesNotThrow(() => haptic('toString'));
  } finally {
    Object.hasOwn = saved;
  }
});

test('震动：原型上的键（constructor、toString）不当成种类', () => {
  const s = setup();
  haptic('constructor');
  haptic('toString');
  haptic('__proto__');
  assert.equal(s.calls.filter((c) => ['impact', 'notify', 'selection'].includes(c[0])).length, 0);
});

test('装上时 webApp 的栏位 getter 或 nav 丢错：installTgChrome 不外泄（审核建议 3）', () => {
  const f = fakeWa({ isFullscreen: true });
  Object.defineProperty(f.wa, 'colorScheme', { get() { throw new Error('boom'); } });
  Object.defineProperty(f.wa, 'isFullscreen', { get() { throw new Error('boom'); } });
  const badNav = { depth() { throw new Error('boom'); }, canPop() { throw new Error('boom'); }, popLayer() {}, onDepthChange() { throw new Error('boom'); } };
  assert.doesNotThrow(() => installTgChrome(f.wa, { root: fakeRoot(), win: new EventTarget(), nav: badNav, defer: fakeDefer() }));
  assert.doesNotThrow(() => { setPageBack(() => {}); f.clickBack(); f.emit('themeChanged'); f.emit('safeAreaChanged'); });
});

test('isVersionAtLeast 丢错 → 全部能力当没有；safeAreaInset getter 丢错 → 当 0', () => {
  const f = fakeWa({ isFullscreen: true });
  f.wa.isVersionAtLeast = () => { throw new Error('boom'); };
  const root = fakeRoot();
  installTgChrome(f.wa, { root, win: new EventTarget(), nav: NAV, defer: fakeDefer() });
  assert.deepEqual(f.calls, [], '没有任何 Telegram 呼叫');
  assert.equal(root.dataset.theme, 'light');
  _resetTgChrome();
  const g = fakeWa({ isFullscreen: true });
  Object.defineProperty(g.wa, 'safeAreaInset', { get() { throw new Error('boom'); } });
  const r2 = fakeRoot();
  assert.doesNotThrow(() => installTgChrome(g.wa, { root: r2, win: new EventTarget(), nav: NAV, defer: fakeDefer() }));
  assert.equal(r2.props.size, 0);
});

test('reset 之后才执行排队的隐藏：旧 webApp 不会收到 hide', () => {
  const s = setup();
  const a = pushLayer({});
  a.close();
  const before = names(s.calls, 'hide').length;
  _resetTgChrome();
  s.defer.flush();
  assert.equal(names(s.calls, 'hide').length, before);
});

test('reset 之后旧 webApp 的事件、浮层变化都不再动任何东西', () => {
  const s = setup({ colorScheme: 'light' });
  _resetTgChrome();
  s.wa.colorScheme = 'dark';
  s.emit('themeChanged');
  pushLayer({});
  s.clickBack();
  assert.equal(s.root.dataset.theme, 'light');
  assert.equal(names(s.calls, 'show').length, 0);
  assert.equal(depth(), 1, '旧的返回键按了也不关浮层');
});

test('同一帧内 要→不要→要→不要：只多 hide 一次', () => {
  const s = setup();
  const a = pushLayer({});
  a.close();
  const b = pushLayer({});
  b.close();
  s.defer.flush();
  assert.equal(names(s.calls, 'hide').length, 2, '安装时一次＋这次一次');
  assert.equal(names(s.calls, 'show').length, 1);
});

test('blocked 之后 setPageBack：不显示，按下也不叫', () => {
  const s = setup();
  s.win.dispatchEvent(new Event('jizhang:blocked'));
  let backs = 0;
  setPageBack(() => { backs += 1; });
  s.defer.flush();
  assert.equal(names(s.calls, 'show').length, 0);
  s.clickBack();
  assert.equal(backs, 0);
});

test('先 setPageBack 再装：装上后照样显示、按下有效', () => {
  let backs = 0;
  setPageBack(() => { backs += 1; });
  const s = setup();
  assert.deepEqual(s.calls.at(-1), ['show']);
  s.clickBack();
  assert.equal(backs, 1);
});

test('登录页给的返回自己丢错：不外泄', () => {
  const s = setup();
  setPageBack(() => { throw new Error('boom'); });
  const orig = console.error;
  console.error = () => {};
  try { assert.doesNotThrow(() => s.clickBack()); } finally { console.error = orig; }
});

test('tgActive：装上前 false、装上后 true、reset 后 false', () => {
  assert.equal(tgActive(), false);
  setup();
  assert.equal(tgActive(), true);
  _resetTgChrome();
  assert.equal(tgActive(), false);
});
