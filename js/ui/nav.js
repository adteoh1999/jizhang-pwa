// 浮层堆叠：sheet、子画面、action sheet、对话框都要入栈。
// 不使用 history API（iOS 主屏幕 App 没有返回手势）；Esc 与日后的 Telegram BackButton 都接到 popLayer。
const stack = [];
const listeners = new Set();

// 只有最上层的元素可操作；其他层（例如 sheet 上又开了 action sheet）的元素设为 inert
function syncInert() {
  stack.forEach((l, i) => { if (l.element) l.element.inert = i !== stack.length - 1; });
}

function notify() {
  syncInert();
  const d = stack.length;
  for (const fn of [...listeners]) {
    try { fn(d); } catch (e) { console.error(e); }
  }
}

// ---------- 闲置回调：浮层全部关闭、而且退场动画都播完 ----------
// 首页在有浮层时把重画延后到这里，动画才会在面板关完后被看到。
let exits = 0;          // 还没播完的退场动画数
const idleQueue = [];

function flushIdle() {
  while (stack.length === 0 && exits === 0 && idleQueue.length) {
    const fn = idleQueue.shift();
    try { fn(); } catch (e) { console.error(e); }
  }
}

/** 现在就闲置 → 同步执行；否则排队，闲置时依加入顺序各执行一次。 */
export function whenIdle(fn) {
  if (stack.length === 0 && exits === 0) { fn(); return; }
  idleQueue.push(fn);
}

/**
 * 登记一段退场动画；回传 release()，播完时呼叫（重复呼叫只算一次）。
 * 保险：timeout 毫秒后自动 release，免得呼叫者漏掉时首页永远不再重画。
 * 要在 onClose 里呼叫（close() 会在 onClose 之后才检查闲置）。
 */
export function trackExit({ timeout = 1000 } = {}) {
  exits += 1;
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    exits -= 1;
    flushIdle();
  };
  const timer = setTimeout(release, timeout);
  if (timer && typeof timer.unref === 'function') timer.unref(); // Node：不拖住测试程序
  return release;
}

/**
 * 推入一层；回传的 close() 只关闭这一层，已关闭再呼叫不做事。
 * element：这一层的根元素（遮罩），不在最上层时自动 inert。
 * onDismiss：popLayer（Esc 等）时改为呼叫它，由它决定要不要 close()（例如先确认放弃修改）。
 */
export function pushLayer({ onClose, onDismiss, element } = {}) {
  const layer = { closed: false, onDismiss, element };
  layer.close = () => {
    if (layer.closed) return;
    layer.closed = true;
    const i = stack.indexOf(layer);
    if (i !== -1) stack.splice(i, 1);
    if (element) element.inert = true; // 退场动画中不可再操作
    // 先通知 depth（app.js 会解除 inert），再 onClose（才能把焦点还原到底下的元素）
    notify();
    try { onClose && onClose(); } catch (e) { console.error(e); }
    flushIdle(); // 在 onClose 之后：onClose 里登记的退场（trackExit）才算得到
  };
  stack.push(layer);
  notify();
  return { close: layer.close };
}

/** 关闭最上层（没有浮层时不做事）。 */
export function popLayer() {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (!top.onDismiss) { top.close(); return; }
  try { top.onDismiss(); } catch (e) { console.error(e); }
}

export const depth = () => stack.length;
/** 没有浮层、退场也播完（whenIdle 会马上执行）。 */
export const isIdle = () => stack.length === 0 && exits === 0;

export function onDepthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
    if (e.key === 'Escape' && stack.length > 0) {
      e.preventDefault();
      popLayer();
    }
  });
}
