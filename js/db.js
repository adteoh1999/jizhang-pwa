// IndexedDB 实作的 DbAdapter（Node 里没有 indexedDB，模块载入时不碰它）
const STORES = ['transactions', 'categories'];

export function openDatabase(name = 'jizhang') {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('此浏览器不支持本地资料库')); return; }
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      const tx = d.createObjectStore('transactions', { keyPath: 'id' });
      tx.createIndex('occurred_on', 'occurred_on');
      tx.createIndex('dirty', 'dirty');
      d.createObjectStore('categories', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onblocked = () => reject(new Error('资料库被其他分页占用，请关闭其他分页后重新整理'));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        globalThis.window?.dispatchEvent(new CustomEvent('jizhang:db-versionchange'));
      };
      resolve(makeAdapter(db));
    };
  });
}

const promisify = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function makeAdapter(db) {
  // 单一 readwrite transaction，oncomplete 才 resolve
  const run = (storeNames, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入被中止'));
    fn(tx);
  });
  return {
    getAll: (store) => promisify(db.transaction(store).objectStore(store).getAll()),
    write(changes) {
      const names = [...STORES.filter((s) => changes[s]), ...(changes.meta ? ['meta'] : [])];
      if (names.length === 0) return Promise.resolve();
      return run(names, (tx) => {
        for (const s of STORES) for (const r of changes[s] || []) tx.objectStore(s).put(r);
        for (const [key, value] of Object.entries(changes.meta || {})) tx.objectStore('meta').put({ key, value });
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
