// 浮层堆叠：sheet、子画面、action sheet、对话框都要入栈。
// 不使用 history API（iOS 主屏幕 App 没有返回手势）；Esc 与日后的 Telegram BackButton 都接到 popLayer。
const stack = [];
const listeners = new Set();

function notify() {
  const d = stack.length;
  for (const fn of [...listeners]) {
    try { fn(d); } catch (e) { console.error(e); }
  }
}

/** 推入一层；回传的 close() 只关闭这一层，已关闭再呼叫不做事。 */
export function pushLayer({ onClose } = {}) {
  const layer = { closed: false };
  layer.close = () => {
    if (layer.closed) return;
    layer.closed = true;
    const i = stack.indexOf(layer);
    if (i !== -1) stack.splice(i, 1);
    try { onClose && onClose(); } catch (e) { console.error(e); }
    notify();
  };
  stack.push(layer);
  notify();
  return { close: layer.close };
}

/** 关闭最上层（没有浮层时不做事）。 */
export function popLayer() {
  const top = stack[stack.length - 1];
  if (top) top.close();
}

export const depth = () => stack.length;

export function onDepthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length > 0) {
      e.preventDefault();
      popLayer();
    }
  });
}
