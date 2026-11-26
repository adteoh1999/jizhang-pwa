// Telegram Mini App 平台判断（3b-6）。
// 只有 Telegram 桥接物件（window.TelegramWebviewProxy）存在才载 telegram.org 的 SDK；
// 一般浏览器／PWA 就算打开带 #tgWebAppData 的链接也当 PWA，并清掉 hash。
// initDataUnsafe 只用来比对本机 tgId、做时效的事前检查；身份一律以服务器验签为准。
// 这里的函数都不会 throw／reject。

export const TG_SDK_URL = 'https://telegram.org/js/telegram-web-app.js?65';
export const TG_SDK_TIMEOUT_MS = 8000;
export const TG_BRIDGE_WAIT_MS = 1500;
// 连接（tg-link bind）的 initData 时效；要和服务器 _shared/telegram.ts 的 TG_BIND_MAX_SEC 相同（tests/telegram-env 检查）
export const TG_BIND_MAX_SEC = 600;
const HINT_KEY = 'jz_tg';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashHasInit(win) {
  try { return String(win.location?.hash ?? '').includes('tgWebAppData='); } catch { return false; }
}

function hasHint(win) {
  if (hashHasInit(win)) return true;
  try { return win.sessionStorage?.getItem(HINT_KEY) === '1'; } catch { return false; }
}

function clearHint(win) {
  try {
    if (hashHasInit(win)) win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}`);
  } catch { /* 清不掉就算了 */ }
  try { win.sessionStorage?.removeItem(HINT_KEY); } catch { /* 同上 */ }
}

// 后备：内嵌脚本没载（例如桥接晚出现）时自己插 SDK。回 Promise<boolean>，同时放在 win.__tgSdk。
function loadTgSdk(win) {
  const p = new Promise((resolve) => {
    try {
      const s = win.document.createElement('script');
      s.src = TG_SDK_URL;
      s.onload = () => resolve(!!(win.Telegram && win.Telegram.WebApp));
      s.onerror = () => resolve(false);
      win.document.head.appendChild(s);
    } catch {
      resolve(false);
    }
  });
  win.__tgSdk = p;
  return p;
}

async function withTimeout(p, ms) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(p).catch(() => false), new Promise((r) => { timer = setTimeout(() => r(false), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function tgIdOf(user) {
  const id = user && typeof user === 'object' ? user.id : undefined;
  if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? String(id) : '';
  if (typeof id === 'string' && /^\d{1,20}$/.test(id) && !/^0+$/.test(id)) return id;
  return '';
}

function authDateOf(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : 0;
  if (typeof v === 'string' && /^\d{1,12}$/.test(v)) return Number(v);
  return 0;
}

export async function detectTelegram({ win = globalThis.window, timeoutMs = TG_SDK_TIMEOUT_MS, bridgeWaitMs = TG_BRIDGE_WAIT_MS } = {}) {
  let bridge = false;
  try {
    if (!win) return { mode: 'pwa' };
    bridge = !!win.TelegramWebviewProxy;
    if (!bridge) {
      if (!hasHint(win)) return { mode: 'pwa' };
      // Android 旧 WebView 可能晚一点才注入桥接
      const end = Date.now() + bridgeWaitMs;
      while (!bridge && Date.now() < end) {
        await sleep(100);
        bridge = !!win.TelegramWebviewProxy;
      }
      if (!bridge) {
        clearHint(win);
        return { mode: 'pwa' };
      }
    }

    await withTimeout(win.__tgSdk ?? loadTgSdk(win), timeoutMs);
    const wa = win.Telegram?.WebApp;
    if (!wa) return { mode: 'tg-broken', reason: 'offline' };
    try { wa.ready(); } catch { /* 忽略 */ }

    const initData = typeof wa.initData === 'string' ? wa.initData : '';
    const unsafe = wa.initDataUnsafe ?? {};
    const tgId = tgIdOf(unsafe.user);
    const authDate = authDateOf(unsafe.auth_date);
    if (!initData || !tgId || !authDate) return { mode: 'tg-broken', reason: 'no-init' };

    try { wa.expand(); } catch { /* 忽略 */ }
    return {
      mode: 'telegram', webApp: wa, initData, tgId, authDate,
      platform: String(wa.platform ?? ''), version: String(wa.version ?? ''),
    };
  } catch {
    return bridge ? { mode: 'tg-broken', reason: 'offline' } : { mode: 'pwa' };
  }
}

// initData 还剩几秒（无条件舍去，可为负）；参数不合格 → 0（当作没时间了）
export function initDataLeft(authDateSec, nowMs, maxSec) {
  if (![authDateSec, nowMs, maxSec].every((x) => typeof x === 'number' && Number.isFinite(x))) return 0;
  return Math.floor(authDateSec + maxSec - nowMs / 1000);
}

export function closeMiniApp(webApp) {
  try { webApp?.close(); } catch { /* 忽略 */ }
}
