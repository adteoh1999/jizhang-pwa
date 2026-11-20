// 资料仓库：记忆体快取 + 串行写入队列。先写 db，成功后才更新快取并通知。
import { uuid as defaultUuid } from './uuid.js';
import {
  defaultCategories, buildTransaction, buildCategory, markDeleted, markRestored, ValidationError,
} from './model.js';
import { compareTx } from './stats.js';
import { toCSV, parseCSV, planImport } from './csv.js';

export function createStore({ db, now = () => new Date(), uuid = defaultUuid }) {
  const txs = new Map(); // 含已删除
  const cats = new Map(); // 含已删除
  const listeners = new Set();
  let queue = Promise.resolve();

  const ctx = () => ({ now: now(), uuid });
  const copy = (r) => Object.freeze({ ...r });

  function enqueue(job) {
    const run = queue.then(job);
    queue = run.catch(() => {}); // 失败不阻断后续写入
    return run;
  }

  function notify() {
    for (const fn of [...listeners]) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  // 写入 db，成功后套用到快取并通知
  async function commit(changes) {
    await db.write(changes);
    for (const t of changes.transactions || []) txs.set(t.id, { ...t });
    for (const c of changes.categories || []) cats.set(c.id, { ...c });
    notify();
  }

  const api = {
    init() {
      return enqueue(async () => {
        const [t, c] = await Promise.all([db.getAll('transactions'), db.getAll('categories')]);
        txs.clear(); cats.clear();
        for (const r of t) txs.set(r.id, r);
        for (const r of c) cats.set(r.id, r);
        if (cats.size === 0) await commit({ categories: defaultCategories() });
      });
    },

    transactions() {
      return [...txs.values()].filter((t) => !t.deleted).sort(compareTx).map(copy);
    },
    categories(kind) {
      return [...cats.values()].filter((c) => !c.deleted && c.kind === kind)
        .sort((a, b) => a.sort - b.sort).map(copy);
    },
    categoryById(id) {
      const c = cats.get(id);
      return c ? copy(c) : undefined;
    },

    saveTransaction(input) {
      return enqueue(async () => {
        const cat = cats.get(input.categoryId);
        if (!cat || cat.kind !== input.kind) throw new ValidationError('category');
        const existing = typeof input.id === 'string' ? txs.get(input.id) || null : null;
        const rec = buildTransaction(input, existing, ctx());
        await commit({ transactions: [rec] });
        return copy(rec);
      });
    },
    deleteTransaction(id) {
      return enqueue(async () => {
        const t = txs.get(id);
        if (!t) throw new Error('找不到这笔记录');
        if (t.deleted) return;
        await commit({ transactions: [markDeleted(t, now())] });
      });
    },
    restoreTransaction(id) {
      return enqueue(async () => {
        const t = txs.get(id);
        if (!t) throw new Error('找不到这笔记录');
        if (!t.deleted) return;
        await commit({ transactions: [markRestored(t, now())] });
      });
    },

    saveCategory(input) {
      return enqueue(async () => {
        const existing = typeof input.id === 'string' ? cats.get(input.id) || null : null;
        let build = input;
        if (!existing) {
          const sorts = [...cats.values()].filter((c) => c.kind === input.kind).map((c) => c.sort);
          build = { ...input, sort: sorts.length ? Math.max(...sorts) + 1 : 0 };
        }
        const rec = buildCategory(build, existing, ctx());
        await commit({ categories: [rec] });
        return copy(rec);
      });
    },
    deleteCategory(id) {
      return enqueue(async () => {
        const c = cats.get(id);
        if (!c) throw new Error('找不到这个分类');
        if (c.deleted) return;
        await commit({ categories: [markDeleted(c, now())] });
      });
    },

    getMeta: (key) => db.getMeta(key),
    setMeta(key, value) {
      return enqueue(async () => {
        await db.write({ meta: { [key]: value } });
      });
    },

    exportCSV() {
      return toCSV([...txs.values()], cats);
    },
    previewImport(text) {
      const rows = parseCSV(text); // 格式错误会 throw
      const plan = planImport(rows, {
        existingTxs: txs, categories: [...cats.values()], now: now(), uuid,
      });
      return { plan, imported: plan.imported, skipped: plan.skipped, newCategoryCount: plan.newCategories.length };
    },
    applyImport(plan) {
      return enqueue(async () => {
        if (plan.txs.length || plan.newCategories.length) {
          await commit({ transactions: plan.txs, categories: plan.newCategories });
        }
        return { imported: plan.imported, skipped: plan.skipped };
      });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}
