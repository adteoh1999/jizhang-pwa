// 同步引擎（2e）：认领本地账本、背景上传（2e-1）、拉取与合并（2e-2）。
// 规则：只有 meta.owner_user_id === session.user_id 才同步——绝不把别人的账传到这个账号。
// 日志只记「步骤 + 状态码 + code」，不记账目内容或 token。
import { loadSession, getValidSession } from './auth.js';
import { upsertRows, selectPage } from './rest.js';
import { normalizeTs } from './timefmt.js';

/** 'mine'（属于这个账号）| 'unclaimed'（还没归属）| 'other'（属于别的账号）。 */
export async function claimState(store, session) {
  const owner = await store.getMeta('owner_user_id');
  if (!owner) return 'unclaimed';
  return owner === session.user_id ? 'mine' : 'other';
}

/** 认领：全部列标待上传，并在同一次写入里写 owner（中途失败就什么都没写，下次重来）。 */
export function claim(store, session) {
  return store.markAllForUpload({ meta: { owner_user_id: session.user_id } });
}

/**
 * 认领执行器：同时只跑一次（进行中再叫回同一个 promise）。ensure(fromUser) 回 claimState 的结果；
 * 'mine' → onMine()；丢错 → onError(e, fromUser)（结果回 'error'），之后还能再叫。
 */
export function createClaimRunner({ ensure, onMine, onError }) {
  let p = null;
  return (fromUser = false) => {
    if (p) return p;
    p = new Promise((res) => res(ensure(fromUser))) // 立刻开始；同步丢错也变成 reject
      .then((st) => { if (st === 'mine') onMine(); return st; })
      .catch((e) => { onError(e, fromUser); return 'error'; })
      .finally(() => { p = null; });
    return p;
  };
}

const DISMISSED = 'syncPromptDismissed'; // 关掉提醒的账号 id（下次启动不再自动问）

/**
 * 需要时认领。回 claimState 的结果。
 * - 没有账（只有默认分类）→ 直接认领，不问。
 * - 有账 → ask(N 笔账) 回 'start' 才认领；其他（关掉）→ 记下来，之后自动启动不再问。
 * - fromUser：用户在设置页按「开始」→ 不看「关掉过」，照样问。
 */
export async function ensureClaimed(store, session, { ask, fromUser = false }) {
  const st = await claimState(store, session);
  if (st !== 'unclaimed') return st;
  const n = store.transactions().length;
  if (n > 0) {
    if (!fromUser && (await store.getMeta(DISMISSED)) === session.user_id) return 'unclaimed';
    const answer = await ask(n);
    const now = await claimState(store, session); // 问的时候别的分页可能已处理
    if (now !== 'unclaimed') return now;
    const cur = await loadSession(store); // 问的时候可能登出了或换了账号
    if (!cur || cur.user_id !== session.user_id) return 'unclaimed';
    if (answer !== 'start') {
      await store.setMeta(DISMISSED, session.user_id);
      return 'unclaimed';
    }
  }
  await claim(store, session);
  return 'mine';
}

// ---------- 上传引擎 ----------
export const BATCH_SIZE = 500;
export const DEBOUNCE_MS = 1000;
export const BACKOFF_BASE_MS = 5000;
export const BACKOFF_MAX_MS = 300_000;
export const POLL_MS = 60_000; // 前景每 60 秒检查一次（尊重退避）
export const FULL_SYNC_EVERY_MS = 24 * 3600_000; // 完整对账最多 24 小时一次（用户 2026-11-25 决定）
const CURSOR_OVERLAP_MS = 60_000; // 增量从游标往回 60 秒（晚提交的交易不会漏）
const CURSOR_SETTLE_MS = 5 * 60_000; // 游标到达超过这么久，就不用再回退
export const LOCK_RETRY_MS = 10_000; // 别的分页在同步：稍后再看一次（不算失败）
const ALL_BAD_MIN = 10;   // 逐笔时至少这么多笔、全是资料错、没有一笔成功 → 当系统错误（前后端不一致），一笔都不标
const ALL_BAD_STOP = 20;  // 连续这么多笔全错、没有成功 → 提早停
const TABLES = ['categories', 'transactions']; // 先分类、再账目（上传与拉取都是）
const cursorKey = (table) => `cursor:${table}`;
const SYNC_LOCK = 'jizhang-sync';

const isOk = (st) => st >= 200 && st < 300;
// 只有资料本身的错（SQLSTATE 22xxx 资料格式、23xxx 违反约束，5 位）才把那笔标成「无法同步」；
// 其他 4xx（PGRST…、42…、403、404、413、没有 code）是系统性错误：整轮停、退避、不标任何列（审核 M3）
const isDataError = (r) => r.status >= 400 && r.status < 500 && typeof r.errorCode === 'string' && /^2[23][0-9A-Z]{3}$/.test(r.errorCode);
const safeCode = (c) => (typeof c === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(c) ? ` ${c}` : '');
export const backoffDelay = (failures) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

/**
 * createSync：背景上传。
 * - 单一执行：跑的时候再被叫 → 记「跑完再来一次」；失败的那轮不接着跑（等退避）。
 * - schedule()：防抖 1 秒；尊重退避（回前景、之后的 60 秒）。schedule({force:true})：用户写入、online、启动，不管退避；
 *   同一个防抖期间只要有一次 force 就算 force。
 * - 每轮：离线 → offline；session 失效 → signed-out；账号与建立时不同 → stale；账本不属于这个账号 → other-owner / unclaimed。
 * - 401 → 带着失败的 token 拿新 session 再试；一轮最多一次。
 * - 只有同一时间一个分页在同步（Web Locks ifAvailable；拿不到 10 秒后再看）。
 * - stop()：进行中的那轮在下一批之前停下；之后不再跑。
 * - syncNow() 回这次的结果：'ok' | 'fail' | 'halt' | 'skip'（只表示引擎跑完，不代表资料全传上去）。
 * - 注意：claim() 不触发 onLocalWrite，认领后呼叫者要自己 schedule({force:true})。
 */
export function createSync({
  store, fetchFn, userId, appVersion,
  getSession = (failedToken) => getValidSession(store, fetchFn, { failedToken }),
  now = Date.now,
  isOnline = () => (globalThis.navigator ? globalThis.navigator.onLine !== false : true),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  win = globalThis.window, doc = globalThis.document,
  locks,
}) {
  const lockApi = locks === undefined ? (globalThis.navigator && globalThis.navigator.locks) : locks;
  const listeners = new Set();
  let state = 'idle';
  let failures = 0;
  let nextAllowedAt = 0;
  let debounceTimer = null;
  let debounceForce = false;
  let retryTimer = null;
  let pollTimer = null;
  let running = null;
  let rerun = false;
  let started = false;
  let stopped = false;
  const cleanups = [];

  // retryInMs：离下次自动重试还剩多久（没有排重试就是 0）
  const status = () => ({
    state, ...store.syncCounts(),
    retryInMs: retryTimer !== null && failures > 0 ? Math.max(0, nextAllowedAt - now()) : 0,
  });
  function emit() {
    if (stopped) return;
    const s = status();
    for (const fn of [...listeners]) {
      try { fn(s); } catch (e) { console.error(e); }
    }
  }
  const setState = (st) => { if (!stopped) { state = st; emit(); } };
  const clearRetry = () => { if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; } };

  // ---- 一轮 ----
  async function round() {
    if (stopped) return 'halt';
    if (!isOnline()) { setState('offline'); return 'halt'; }
    setState('syncing');
    let g = await getSession(null);
    if (g.invalid) { setState('signed-out'); return 'halt'; }
    if (!g.session) return 'fail';
    if (g.session.user_id !== userId) { setState('stale'); return 'halt'; }
    let session = g.session;
    const st = await claimState(store, { user_id: userId });
    if (st !== 'mine') { setState(st === 'other' ? 'other-owner' : 'unclaimed'); return 'halt'; }
    // 归属核对过才动资料：App 更新了 → 坏资料重试一次
    if ((await store.getMeta('syncErrorVersion')) !== appVersion) {
      if ((await store.clearSyncErrors({ owner: userId })) === null) { setState('other-owner'); return 'halt'; }
      await store.setMeta('syncErrorVersion', appVersion);
    }

    let refreshed = false;
    // 发一次请求；401 → 刷新一次再发（上传与拉取合计一轮最多一次）。回请求结果，或 'fail' / 'halt'
    async function withAuth(what, call) {
      for (;;) {
        if (stopped) return 'halt';
        const r = await call(session.access_token);
        if (r.status !== 401) return r;
        if (refreshed) { console.warn(`[sync] ${what} 失败：HTTP 401（刷新后仍被拒）`); return 'fail'; }
        refreshed = true;
        g = await getSession(session.access_token);
        if (g.invalid) { setState('signed-out'); return 'halt'; }
        if (!g.session) return 'fail';
        if (g.session.user_id !== userId) { setState('stale'); return 'halt'; }
        session = g.session;
      }
    }
    const send = (table, rows) => withAuth(`上传 ${table}`, (tok) => upsertRows(fetchFn, table, rows, tok));
    const logFail = (table, r) => console.warn(`[sync] 上传 ${table} 失败：HTTP ${r.status}${safeCode(r.errorCode)}`);
    // 2xx 但回应不是清单：不能当成功（会把没写进去的账标成已同步）
    const badOk = (table, r) => { console.warn(`[sync] 上传 ${table} 回应格式不对：HTTP ${r.status}`); return 'fail'; };
    // 写回都核对 owner（别的分页换了账号 → 回 null → 停，不把旧账号的快取写回去）
    const ownerGone = () => { setState('other-owner'); return 'halt'; };
    const uploaded = (table, sent, rows) => store.markUploaded(table, sent, rows, { owner: userId });
    const syncError = (table, row, code) => store.markSyncError(table, row.id, code, row.updated_at, { owner: userId });

    for (const table of TABLES) {
      const rows = await store.pendingRows(table);
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        if (stopped) return 'halt';
        const batch = rows.slice(i, i + BATCH_SIZE);
        const r = await send(table, batch);
        if (typeof r === 'string') return r;
        if (isOk(r.status)) {
          if (!r.rows) return badOk(table, r);
          if ((await uploaded(table, batch, r.rows)) === null) return ownerGone();
          continue;
        }
        if (!isDataError(r)) { logFail(table, r); return 'fail'; }
        if (batch.length === 1) {
          logFail(table, r);
          if ((await syncError(table, batch[0], r.errorCode)) === null) return ownerGone();
          continue;
        }
        // 整批有坏资料 → 逐笔找出是哪几笔。先收集，最后才标：全错（前后端不一致）就一笔都不标
        const bad = [];
        let good = 0;
        for (const row of batch) {
          const one = await send(table, [row]);
          if (typeof one === 'string') return one;
          if (isOk(one.status)) {
            if (!one.rows) return badOk(table, one);
            if ((await uploaded(table, [row], one.rows)) === null) return ownerGone();
            good++;
          } else if (isDataError(one)) {
            bad.push([row, one.errorCode]);
            if (good === 0 && bad.length >= ALL_BAD_STOP) break;
          } else { logFail(table, one); return 'fail'; }
        }
        if (good === 0 && bad.length >= ALL_BAD_MIN) {
          console.warn(`[sync] 上传 ${table}：${bad.length} 笔全被拒${safeCode(bad[0][1])}，当成系统错误、稍后重试`);
          return 'fail';
        }
        for (const [row, code] of bad) {
          console.warn(`[sync] 上传 ${table} 有一笔被拒${safeCode(code)}`);
          if ((await syncError(table, row, code)) === null) return ownerGone();
        }
      }
    }

    // ---- 拉取（先上传、再拉取：本地改动先进服务器，拉回来的就不会是旧版）----
    const acc = { adopted: 0 };
    let res;
    try {
      res = await pull(acc);
    } finally {
      if (acc.adopted) store.notifyChanged(); // 一轮最多通知一次；中途失败也通知已采用的（审核 M-1）
    }
    return res;

    async function pull(acc) {
      const fullAt = await store.getMeta('fullSyncAt');
      // 在未来（时钟曾经快）也算到期（审核 S-3）
      const fullDue = !(typeof fullAt === 'number' && fullAt <= now() && now() - fullAt < FULL_SYNC_EVERY_MS);
      let missing = 0;
      for (const table of TABLES) {
        let stored = await store.getMeta(cursorKey(table));
        const curTs = stored && typeof stored.ts === 'string' && typeof stored.id === 'string' ? normalizeTs(stored.ts) : null;
        const full = fullDue || curTs === null;
        let after = null;
        let since = null;
        if (!full) {
          // 游标到达超过 5 分钟（晚提交的交易早已落地）→ 直接从游标接着拉；否则回退 60 秒（审核 S-1）
          const age = typeof stored.at === 'number' ? now() - stored.at : -1;
          if (age >= CURSOR_SETTLE_MS) after = { ts: stored.ts, id: stored.id };
          else since = new Date(Date.parse(curTs) - CURSOR_OVERLAP_MS).toISOString();
        }
        // S9 只在 24 小时一次的完整对账做（没游标的完整拉取不做）：服务器若拉取永远回空，也不会无限重传
        const ids = fullDue ? new Set() : null;
        for (;;) { // 拉到空页才算完
          if (stopped) return 'halt';
          const r = await withAuth(`拉取 ${table}`, (tok) => selectPage(fetchFn, table, { after, since }, tok));
          if (typeof r === 'string') return r;
          if (stopped) return 'halt'; // 请求途中停下：回来后不写（审核 S-2）
          if (!isOk(r.status)) {
            console.warn(`[sync] 拉取 ${table} 失败：HTTP ${r.status}${safeCode(r.errorCode)}`);
            // 4xx（不含 429）：游标可能坏了 → 丢掉，下次完整拉取
            if (r.status >= 400 && r.status < 500 && r.status !== 429) await store.setMeta(cursorKey(table), null);
            return 'fail';
          }
          if (!r.rows) { console.warn(`[sync] 拉取 ${table} 回应格式不对：HTTP ${r.status}`); return 'fail'; }
          if (r.rows.length === 0) break;
          const last = r.rows[r.rows.length - 1];
          if (typeof last.server_updated_at !== 'string' || typeof last.id !== 'string') {
            console.warn(`[sync] 拉取 ${table} 回应少了游标栏位`);
            return 'fail';
          }
          if (after && after.ts === last.server_updated_at && after.id === last.id) {
            console.warn(`[sync] 拉取 ${table} 游标没前进（服务器没照条件分页），停下`);
            return 'fail';
          }
          after = { ts: last.server_updated_at, id: last.id }; // 原字串（微秒不能丢）
          since = null;
          if (ids) for (const row of r.rows) ids.add(row.id);
          // 这页资料与游标同一次写入（游标没变就不写，留着原本的到达时间）；owner 不是这个账号了 → 停
          const moved = !stored || stored.ts !== after.ts || stored.id !== after.id;
          const cursor = moved ? { ...after, at: now() } : null;
          const n = await store.applyRemote(table, r.rows, { meta: cursor ? { [cursorKey(table)]: cursor } : undefined, owner: userId, silent: true });
          if (n === null) return ownerGone();
          if (cursor) stored = cursor;
          acc.adopted += n;
        }
        if (ids) {
          if (stopped) return 'halt';
          const m = await store.markMissingForUpload(table, ids, { owner: userId });
          if (m === null) return ownerGone();
          if (m) console.warn(`[sync] 完整对账：${table} 有 ${m} 笔不在服务器上，重新上传`);
          missing += m;
        }
      }
      if (stopped) return 'halt';
      if (fullDue) await store.setMeta('fullSyncAt', now());
      if (missing) rerun = true; // 马上再跑一轮把它们传上去
      return 'ok';
    }
  }

  function withSyncLock(fn) {
    if (lockApi && typeof lockApi.request === 'function') {
      return lockApi.request(SYNC_LOCK, { ifAvailable: true }, (lock) => (lock ? fn() : 'skip'));
    }
    return fn();
  }

  async function runOnce() {
    let res;
    try {
      res = await withSyncLock(round);
    } catch (e) {
      console.warn(`[sync] 同步出错：${e && e.name ? e.name : '未知'}`);
      res = 'fail';
    }
    if (stopped) return res;
    if (res === 'ok') {
      failures = 0;
      nextAllowedAt = 0;
      clearRetry();
      setState('idle');
    } else if (res === 'fail') {
      failures += 1;
      const delay = backoffDelay(failures);
      nextAllowedAt = now() + delay;
      clearRetry();
      retryTimer = setTimer(() => { retryTimer = null; syncNow(); }, delay);
      setState('error');
    } else if (res === 'halt') {
      clearRetry();
    } else if (res === 'skip' && retryTimer === null) {
      retryTimer = setTimer(() => { retryTimer = null; syncNow(); }, LOCK_RETRY_MS);
    }
    return res;
  }

  function syncNow() {
    if (stopped) return Promise.resolve('halt');
    if (running) { rerun = true; return running; }
    running = (async () => {
      let res;
      try {
        do {
          rerun = false;
          res = await runOnce();
        } while (rerun && res !== 'fail' && !stopped);
      } finally {
        running = null;
      }
      return res;
    })();
    return running;
  }

  function schedule({ force = false } = {}) {
    if (stopped) return;
    debounceForce = debounceForce || force;
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = setTimer(() => {
      debounceTimer = null;
      const f = debounceForce;
      debounceForce = false;
      if (!f && now() < nextAllowedAt) return; // 退避中：等 retryTimer
      syncNow();
    }, DEBOUNCE_MS);
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      cleanups.push(store.onLocalWrite(() => schedule({ force: true })));
      const onOnline = () => schedule({ force: true });
      const onVisible = () => { if (!doc || doc.visibilityState === 'visible') schedule(); };
      if (win && win.addEventListener) {
        win.addEventListener('online', onOnline);
        cleanups.push(() => win.removeEventListener('online', onOnline));
      }
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', onVisible);
        cleanups.push(() => doc.removeEventListener('visibilitychange', onVisible));
      }
      // 前景每 60 秒检查一次（不 force：退避中不发）
      const poll = () => {
        pollTimer = setTimer(() => {
          pollTimer = null;
          if (stopped) return;
          if (!doc || doc.visibilityState === 'visible') schedule();
          poll();
        }, POLL_MS);
      };
      poll();
      schedule({ force: true });
    },
    schedule,
    syncNow,
    status,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    stop() {
      if (stopped) return;
      state = 'stopped';
      stopped = true;
      for (const c of cleanups.splice(0)) { try { c(); } catch { /* 忽略 */ } }
      if (debounceTimer !== null) { clearTimer(debounceTimer); debounceTimer = null; }
      clearRetry();
      if (pollTimer !== null) { clearTimer(pollTimer); pollTimer = null; }
      listeners.clear();
    },
  };
}
