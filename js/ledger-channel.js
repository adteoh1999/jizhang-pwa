// 跨分页通知「这台设备的账本已清除」（换账号、登出、删号之后），其他分页显示「需要重新载入」。
// 同一个分页共用同一个频道物件（自己发的不会收到）；用到才建立。没有 BroadcastChannel 的浏览器什么都不做
// （保底：store 用户写入时核对账本代号）。
let ch = null;
function channel() {
  if (ch === null && typeof BroadcastChannel === 'function') {
    try { ch = new BroadcastChannel('jizhang-ledger'); } catch { ch = false; }
  }
  return ch || null;
}

export function announceLedgerReset() {
  try { channel()?.postMessage('reset'); } catch { /* 忽略 */ }
}

// 这个分页拉回了别台设备的改动（已写进资料库）：其他分页重新载入快取（2e-3；只有拿到同步锁的分页会拉取）
export function announcePulled() {
  try { channel()?.postMessage('pulled'); } catch { /* 忽略 */ }
}

export function onPulledElsewhere(fn) {
  const c = channel();
  if (!c) return () => {};
  const h = (e) => { if (e.data === 'pulled') fn(); };
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}

export function onLedgerResetElsewhere(fn) {
  const c = channel();
  if (!c) return () => {};
  const h = (e) => { if (e.data === 'reset') fn(); };
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}
