// 记忆体版 DbAdapter：行为对齐 IndexedDB（深拷贝存取）。表清单跟 js/db.js 同一份（3e：加关键词表）。
import { STORES } from '../../js/db.js';

const WRITE_KEYS = ['remove', 'clear', 'meta', 'clearMeta', 'expect'];

export function createMemoryDb() {
  const stores = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  const meta = new Map();
  const calls = [];
  let failure = null;
  const known = (s) => { if (!stores[s]) throw new Error(`未知的资料表：${s}`); return stores[s]; };
  return {
    calls,
    failNextWrite(err) { failure = err; },
    async getAll(store) { return [...known(store).values()].map((r) => structuredClone(r)); },
    async write(changes) {
      for (const k of Object.keys(changes)) if (!stores[k] && !WRITE_KEYS.includes(k)) throw new Error(`未知的资料键：${k}`);
      if (failure) { const e = failure; failure = null; throw e; }
      for (const [k, v] of Object.entries(changes.expect || {})) {
        if (((meta.has(k) ? meta.get(k) : null) ?? null) !== (v ?? null)) { const e = new Error('meta 不符'); e.name = 'MetaMismatch'; throw e; }
      }
      calls.push(Object.keys(changes).filter((k) => k !== 'expect'));
      const rm = changes.remove || {};
      if (changes.clearMeta) meta.clear();
      for (const s of changes.clear || []) known(s).clear();
      for (const s of Object.keys(rm)) known(s);
      for (const s of STORES) {
        for (const id of rm[s] || []) stores[s].delete(id);
        for (const r of changes[s] || []) stores[s].set(r.id, structuredClone(r));
      }
      for (const [k, v] of Object.entries(changes.meta || {})) meta.set(k, structuredClone(v));
    },
    metaKeys() { return [...meta.keys()].sort(); },
    async getMeta(key) { return meta.has(key) ? structuredClone(meta.get(key)) : undefined; },
    async clear() { for (const m of Object.values(stores)) m.clear(); meta.clear(); },
    close() {},
  };
}
