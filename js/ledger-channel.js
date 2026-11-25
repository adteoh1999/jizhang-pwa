// 跨分页通知「这台设备的账本已换成另一个账号」（换账号清除后），其他分页显示「需要重新载入」。
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

export function onLedgerResetElsewhere(fn) {
  const c = channel();
  if (!c) return () => {};
  const h = (e) => { if (e.data === 'reset') fn(); };
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}
