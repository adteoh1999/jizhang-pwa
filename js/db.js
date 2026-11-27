// IndexedDB 实作的 DbAdapter（Node 里没有 indexedDB，模块载入时不碰它）
// 资料表（3e 加关键词）。版本 2：v1 是账目、分类、meta；v2 加 category_keywords（主键 id＝关键词）。
// 注意：升到 v2 之后，旧版程式（v3.4.x）开这个资料库会 VersionError → 前端只能往前修，不能退回旧版。
export const STORES = ['transactions', 'categories', 'category_keywords'];
export const DB_VERSION = 2;
export const BLOCKED_WAIT_MS = 8000;
const BLOCKED_MSG = '资料库被其他分页占用，请关闭其他分页后重新整理';

/**
 * 开资料库。idb、计时器可注入（测试用）。
 * 升级按 oldVersion 分段（不能无条件建全部 store：旧用户会 ConstraintError）。
 * blocked（别的分页还开着旧连线）：先等 BLOCKED_WAIT_MS；那段时间开成功就照常用，等不到才显示「请关闭其他分页」。
 * 超时之后才开成功的连线没人要 → 马上关掉（不留会挡住下次升级的连线）。画面已经是「请关闭其他分页后重新整理」，
 * 不再发 jizhang:db-versionchange（真浏览器测试：会叠出第二段「需要重新载入」）。
 */
export function openDatabase(name = 'jizhang', {
  idb = globalThis.indexedDB, blockedWaitMs = BLOCKED_WAIT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
} = {}) {
  return new Promise((resolve, reject) => {
    if (!idb) { reject(new Error('此浏览器不支持本地资料库')); return; }
    const req = idb.open(name, DB_VERSION);
    let settled = false;
    let blockedTimer = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimer(blockedTimer);
      reject(err);
    };
    req.onupgradeneeded = (e) => {
      const d = req.result;
      const old = e && typeof e.oldVersion === 'number' ? e.oldVersion : 0;
      if (old < 1) {
        const tx = d.createObjectStore('transactions', { keyPath: 'id' });
        tx.createIndex('occurred_on', 'occurred_on');
        tx.createIndex('dirty', 'dirty');
        d.createObjectStore('categories', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
      }
      if (old < 2 && !d.objectStoreNames.contains('category_keywords')) {
        d.createObjectStore('category_keywords', { keyPath: 'id' });
      }
    };
    req.onblocked = () => {
      if (settled || blockedTimer) return;
      blockedTimer = setTimer(() => fail(new Error(BLOCKED_MSG)), blockedWaitMs);
    };
    req.onerror = () => {
      const e = req.error;
      if (e && e.name === 'VersionError') {
        const err = new Error('App 有新版本，请重新整理更新');
        err.name = 'VersionError';
        fail(err);
        return;
      }
      fail(e);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { // 已经显示「请关闭其他分页」：这条连线没人用，关掉
        try { db.close(); } catch { /* 已关 */ }
        return;
      }
      settled = true;
      if (blockedTimer) clearTimer(blockedTimer);
      db.onversionchange = () => {
        db.close();
        globalThis.window?.dispatchEvent(new CustomEvent('jizhang:db-versionchange'));
      };
      // 连线被系统意外关闭（储存空间清理等）：同一条阻挡画面路径
      db.onclose = () => globalThis.window?.dispatchEvent(new CustomEvent('jizhang:db-versionchange'));
      resolve(makeAdapter(db));
    };
  });
}

const WRITE_KEYS = ['remove', 'clear', 'meta', 'clearMeta', 'expect'];
const promisify = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function makeAdapter(db) {
  // 单一 readwrite transaction，oncomplete 才 resolve
  // fn(tx, abortWith)：abortWith(err) 中止整个 transaction，以 err 回 reject
  const run = (storeNames, fn) => new Promise((resolve, reject) => {
    let tx;
    let failure = null; // 第一个错误，onabort 时用
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err instanceof Error ? err : new Error('写入失败'));
    };
    try {
      tx = db.transaction(storeNames, 'readwrite');
      tx.oncomplete = () => { if (!done) { done = true; resolve(); } };
      // error 事件时 tx.error 还是 null，真正的失败在 abort 时才确定
      tx.onerror = (ev) => { if (!failure) failure = ev.target && ev.target.error; };
      tx.onabort = () => fail(failure || tx.error);
      fn(tx, (err) => { failure = err; tx.abort(); });
    } catch (e) {
      failure = e;
      fail(e);
      try { tx && tx.abort(); } catch { /* 已结束 */ }
    }
  });
  return {
    async getAll(store) { return promisify(db.transaction(store).objectStore(store).getAll()); },
    write(changes) {
      // changes.clear = ['transactions', …]：先清空整个表（换账号用）
      // changes.remove = {transactions: [id…]}：再删（同步换 id 用）；最后写。同一个 transaction
      const rm = changes.remove || {};
      const cl = changes.clear || [];
      // changes.clearMeta = true：清空整个 meta（登出、删号用），再写 changes.meta
      // changes.expect = {meta 键: 值}：同一个 transaction 里先读，不符就整个中止（MetaMismatch），什么都不写
      const exp = Object.entries(changes.expect || {});
      // 不认识的资料键（例如漏加进 STORES 的新表）→ 报错，不能静默不写
      for (const k of Object.keys(changes)) {
        if (!STORES.includes(k) && !WRITE_KEYS.includes(k)) throw new Error(`未知的资料键：${k}`);
      }
      for (const s of [...cl, ...Object.keys(rm)]) if (!STORES.includes(s)) throw new Error(`未知的资料表：${s}`);
      const names = [...STORES.filter((s) => changes[s] || rm[s] || cl.includes(s)), ...(changes.meta || changes.clearMeta || exp.length ? ['meta'] : [])];
      if (names.length === 0) return Promise.resolve();
      return run(names, (tx, abortWith) => {
        const writeAll = () => {
          for (const s of STORES) if (cl.includes(s)) tx.objectStore(s).clear();
          if (changes.clearMeta) tx.objectStore('meta').clear();
          for (const s of STORES) for (const id of rm[s] || []) tx.objectStore(s).delete(id);
          for (const s of STORES) for (const r of changes[s] || []) tx.objectStore(s).put(r);
          for (const [key, value] of Object.entries(changes.meta || {})) tx.objectStore('meta').put({ key, value });
        };
        if (!exp.length) { writeAll(); return; }
        let left = exp.length;
        let bad = false;
        for (const [key, want] of exp) {
          const req = tx.objectStore('meta').get(key);
          req.onsuccess = () => {
            const have = req.result ? req.result.value : null;
            if ((have ?? null) !== (want ?? null)) bad = true;
            if (--left > 0) return;
            if (!bad) { writeAll(); return; }
            const e = new Error('meta 不符');
            e.name = 'MetaMismatch';
            abortWith(e);
          };
        }
      });
    },
    async getMeta(key) {
      const rec = await promisify(db.transaction('meta').objectStore('meta').get(key));
      return rec ? rec.value : undefined;
    },
    clear() {
      const all = [...STORES, 'meta'];
      return run(all, (tx) => all.forEach((s) => tx.objectStore(s).clear()));
    },
    close() { db.close(); },
  };
}
