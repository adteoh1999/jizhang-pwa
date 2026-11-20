// 新版本状态：app.js 的 SW 注册把「有新 worker 在等」告诉这里，设置页等处订阅。
let reg = null;
let waitingWorker = null;
let available = false;
const listeners = new Set();

export const isUpdateAvailable = () => available;

/** 订阅「有新版本」；已经有的话立刻呼叫。回传取消订阅函数。 */
export function onUpdateAvailable(fn) {
  listeners.add(fn);
  if (available) fn();
  return () => listeners.delete(fn);
}

/** 由 SW 注册逻辑呼叫。 */
export function markUpdateAvailable(registration, worker) {
  reg = registration;
  waitingWorker = worker;
  available = true;
  [...listeners].forEach((f) => f());
}

/** 让等待中的 worker 接管；controllerchange 时 app.js 会重载。 */
export function applyUpdate() {
  const w = (reg && reg.waiting) || waitingWorker;
  if (w) w.postMessage({ type: 'SKIP_WAITING' });
}
