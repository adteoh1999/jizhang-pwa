// 记忆体版 DbAdapter：行为对齐 IndexedDB（深拷贝存取）
export function createMemoryDb() {
  const stores = { transactions: new Map(), categories: new Map() };
  const meta = new Map();
  const calls = [];
  let failure = null;
  return {
    calls,
    failNextWrite(err) { failure = err; },
    async getAll(store) { return [...stores[store].values()].map((r) => structuredClone(r)); },
    async write(changes) {
      if (failure) { const e = failure; failure = null; throw e; }
      calls.push(Object.keys(changes));
      for (const s of ['transactions', 'categories']) {
        for (const r of changes[s] || []) stores[s].set(r.id, structuredClone(r));
      }
      for (const [k, v] of Object.entries(changes.meta || {})) meta.set(k, structuredClone(v));
    },
    async getMeta(key) { return meta.has(key) ? structuredClone(meta.get(key)) : undefined; },
    async clear() { stores.transactions.clear(); stores.categories.clear(); meta.clear(); },
    close() {},
  };
}
