// 2e-3：Supabase Realtime「门铃」。服务器上自己的账目／分类有新增或修改 → onPoke()（叫同步引擎跑一轮）。
// 推送内容本身不拿来用：合并只走同步引擎那一条路（LWW、游标、owner／账本代号检查都沿用）。
// 只在画面显示、在线、允许同步时连线；切到背景、离线、登出、换账号就断。60 秒定时检查与回前景检查照旧当备用。
// 协议：Phoenix vsn 1.0.0 JSON 物件（官方 https://supabase.com/docs/guides/realtime/protocol）。
// log 只印原因代号，不印 token 或推送内容。
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const HEARTBEAT_MS = 25_000; // 官方：至少每 25 秒一次
// 整段连线（拿 token → socket open → 「Subscribed to PostgreSQL」）的期限：任何一段卡住（auth 锁、网络）都会重来
export const CONNECT_TIMEOUT_MS = 20_000;
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 60_000;

const TABLES = ['transactions', 'categories'];
// 不用 '*'：DELETE 事件不过 RLS（服务器端 publication 也只发 insert、update）
const EVENTS = ['INSERT', 'UPDATE'];

export const realtimeUrl = () => `${SUPABASE_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`;

/**
 * createRealtime → { start(), stop(), check(), state(), subscribe(fn) }
 * - getSession(failedToken)：回 {session} | {invalid} | {retry}（同 getValidSession）。join 因 token 被拒时，
 *   下一次连线带着那个 token 强制刷新；同一条重连链只强制一次（时钟不准时不会一直打刷新接口）。
 * - allowed()：同步引擎状态允许时才连（check() 会重新判断）。
 * - state()：'off' | 'connecting' | 'live'。
 */
export function createRealtime({
  userId, getSession, onPoke,
  allowed = () => true,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  win = globalThis.window, doc = globalThis.document,
  isOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true),
  url = realtimeUrl(),
}) {
  const topic = `realtime:ledger-${userId}`;
  const listeners = new Set();
  const cleanups = [];
  let st = 'off';
  let started = false;
  let stopped = false;
  let ws = null;
  let conn = 0; // 连线代号：旧连线的回呼一律不理
  let connecting = false;
  let ref = 0;
  let joinRef = null;
  let ids = new Set();
  let hbTimer = null;
  let hbPending = null;
  let subTimer = null;
  let retryTimer = null;
  let attempts = 0;
  let forceToken = null;
  let refreshedInChain = false;

  const setSt = (s) => {
    if (s === st) return;
    st = s;
    for (const fn of [...listeners]) { try { fn(s); } catch (e) { console.error(e); } }
  };
  const visible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
  const wanted = () => started && !stopped && allowed() && visible() && isOnline();
  const nextRef = () => String(++ref);
  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch { /* 断线由 onclose 处理 */ } };
  const clearRetry = () => { if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; } };
  const poke = () => { try { onPoke(); } catch (e) { console.error(e); } };

  function teardown() {
    conn++;
    connecting = false;
    if (hbTimer !== null) { clearTimer(hbTimer); hbTimer = null; }
    if (subTimer !== null) { clearTimer(subTimer); subTimer = null; }
    hbPending = null;
    ids = new Set();
    if (ws) {
      const old = ws;
      ws = null;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch { /* 忽略 */ }
    }
  }

  function scheduleRetry() {
    clearRetry();
    if (!wanted()) { setSt('off'); return; }
    setSt('connecting');
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
    attempts++;
    retryTimer = setTimer(() => { retryTimer = null; check(); }, delay);
  }

  function fail(reason) {
    if (stopped) return;
    console.warn(`[realtime] 连线中断：${reason}，稍后重连`);
    teardown();
    scheduleRetry();
  }

  function heartbeat(my) {
    hbTimer = setTimer(() => {
      hbTimer = null;
      if (my !== conn) return;
      if (hbPending !== null) { fail('心跳没回覆'); return; }
      hbPending = nextRef();
      send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: hbPending });
      heartbeat(my);
    }, HEARTBEAT_MS);
  }

  function onMessage(my, token, raw) {
    if (my !== conn) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.topic === 'phoenix') {
      if (m.event === 'phx_reply' && m.ref === hbPending) hbPending = null;
      return;
    }
    if (m.topic !== topic) return;
    const p = m.payload || {};
    if (m.event === 'phx_reply' && m.ref === joinRef) {
      if (p.status === 'ok') {
        const list = (p.response && Array.isArray(p.response.postgres_changes)) ? p.response.postgres_changes : [];
        ids = new Set(list.map((x) => x && x.id).filter((x) => x !== undefined));
        poke(); // 补上「连线前」的改动
        return;
      }
      const reason = String((p.response && p.response.reason) || '');
      if (/token|jwt/i.test(reason) && !refreshedInChain) { forceToken = token; refreshedInChain = true; }
      fail('加入被拒');
      return;
    }
    if (m.event === 'system') {
      if (p.status === 'ok' && p.extension === 'postgres_changes') {
        if (subTimer !== null) { clearTimer(subTimer); subTimer = null; }
        attempts = 0;
        refreshedInChain = false;
        setSt('live');
        poke(); // 订阅建立前的空档：再补一次（防抖会合并）
        return;
      }
      if (p.status === 'error' || p.status === 'timeout') {
        if (/token|jwt/i.test(String(p.message || '')) && !refreshedInChain) { forceToken = token; refreshedInChain = true; }
        fail('订阅出错');
      }
      return;
    }
    if (m.event === 'postgres_changes') {
      const got = Array.isArray(p.ids) ? p.ids : [];
      if (got.some((id) => ids.has(id))) poke();
      else fail('订阅代号对不上');
      return;
    }
    if (m.event === 'phx_close' || m.event === 'phx_error') fail(m.event);
    // 其他事件（broadcast、presence…）不按门铃：任何人都能对公开频道发 broadcast
  }

  async function connect() {
    teardown();
    const my = conn;
    connecting = true;
    setSt('connecting');
    subTimer = setTimer(() => { subTimer = null; if (my === conn) fail('连线逾时'); }, CONNECT_TIMEOUT_MS);
    let g;
    try { g = await getSession(forceToken); } catch { g = { retry: true }; }
    if (my !== conn) return;
    connecting = false;
    if (!wanted()) { teardown(); setSt('off'); return; }
    if (!g || !g.session) {
      if (g && g.invalid) { forceToken = null; teardown(); setSt('off'); return; } // 登录过期：等同步引擎显示「重新登录」
      teardown();
      scheduleRetry(); // retry：强制刷新还没成功 → forceToken 留着，下次仍强制
      return;
    }
    forceToken = null;
    // 别的分页换了账号、这里还没发现：不用别人的 token 订这个账号的频道
    if (g.session.user_id && g.session.user_id !== userId) { teardown(); setSt('off'); return; }
    const token = g.session.access_token;
    let sock;
    try { sock = new WebSocketImpl(url); } catch { scheduleRetry(); return; }
    ws = sock;
    sock.onopen = () => {
      if (my !== conn) return;
      joinRef = nextRef();
      send({
        topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: TABLES.flatMap((table) => EVENTS.map((event) => ({ event, schema: 'public', table, filter: `user_id=eq.${userId}` }))),
            private: false,
          },
          access_token: token,
        },
      });
      heartbeat(my);
    };
    sock.onmessage = (e) => onMessage(my, token, e && e.data);
    sock.onclose = () => { if (my === conn) fail('socket 关闭'); };
    sock.onerror = () => {}; // 之后会有 close
  }

  function check() {
    if (!wanted()) {
      clearRetry();
      teardown();
      setSt('off');
      return;
    }
    if (ws || connecting || retryTimer !== null) return;
    connect();
  }

  // 回前景、pageshow、online：旧连线可能已经死了（iOS 冻结），一律关掉重开
  function restart() {
    if (!started || stopped) return;
    clearRetry();
    teardown();
    attempts = 0;
    refreshedInChain = false;
    check();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      const on = (target, name, fn) => {
        if (target && target.addEventListener) {
          target.addEventListener(name, fn);
          cleanups.push(() => target.removeEventListener(name, fn));
        }
      };
      on(doc, 'visibilitychange', () => { if (visible()) restart(); else check(); });
      on(win, 'pagehide', () => { clearRetry(); teardown(); setSt('off'); });
      on(win, 'pageshow', (e) => { if (e && e.persisted) restart(); }); // 从 bfcache 回来才重开（第一次载入也会发 pageshow）
      on(win, 'online', restart);
      on(win, 'offline', check);
      check();
    },
    check() { if (started && !stopped) check(); },
    state: () => st,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const c of cleanups.splice(0)) { try { c(); } catch { /* 忽略 */ } }
      clearRetry();
      teardown();
      setSt('off');
      listeners.clear();
    },
  };
}
