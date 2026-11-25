// 资料仓库：记忆体快取 + 串行写入队列。先写 db，成功后才更新快取并通知。
import { uuid as defaultUuid } from './uuid.js';
import {
  defaultCategories, buildTransaction, buildCategory, markDeleted, markRestored, ValidationError,
} from './model.js';
import { compareTx } from './stats.js';
import { toCSV, parseCSV, planImport } from './csv.js';
import { normalizeTs, isUuid } from './timefmt.js';

const TABLES = ['transactions', 'categories'];
const withoutSyncError = (r) => { const { sync_error: _drop, ...rest } = r; return rest; };

export function createStore({ db, now = () => new Date(), uuid = defaultUuid }) {
  const txs = new Map(); // 含已删除
  const cats = new Map(); // 含已删除
  const listeners = new Set();
  const localListeners = new Set(); // 只有用户的写入才通知（同步用来排程上传）
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

  function notifyLocal() {
    for (const fn of [...localListeners]) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
  const mapOf = (table) => {
    if (table === 'transactions') return txs;
    if (table === 'categories') return cats;
    throw new Error(`未知的表：${table}`);
  };

  // 写入 db，成功后套用到快取并通知。local：用户的写入（同步会排程上传）；silent：不通知画面
  async function commit(changes, { local = false, silent = false } = {}) {
    await db.write(changes);
    const rm = changes.remove || {};
    for (const id of rm.transactions || []) txs.delete(id);
    for (const id of rm.categories || []) cats.delete(id);
    for (const t of changes.transactions || []) txs.set(t.id, { ...t });
    for (const c of changes.categories || []) cats.set(c.id, { ...c });
    if (!silent) notify();
    if (local) notifyLocal();
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
        // 带的 id 本地找不到、又不是小写 uuid（例如认领换 id 后，开着的旧面板存档）→ 换新 uuid，不用怪 id 新建
        if (!existing && typeof input.id === 'string' && !(isUuid(input.id) && input.id === input.id.toLowerCase())) {
          input = { ...input, id: undefined };
        }
        const rec = buildTransaction(input, existing, ctx());
        await commit({ transactions: [rec] }, { local: true });
        return copy(rec);
      });
    },
    deleteTransaction(id) {
      return enqueue(async () => {
        const t = txs.get(id);
        if (!t) throw new Error('找不到这笔记录');
        if (t.deleted) return;
        await commit({ transactions: [markDeleted(t, now())] }, { local: true });
      });
    },
    restoreTransaction(id) {
      return enqueue(async () => {
        const t = txs.get(id);
        if (!t) throw new Error('找不到这笔记录');
        if (!t.deleted) return;
        await commit({ transactions: [markRestored(t, now())] }, { local: true });
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
        await commit({ categories: [rec] }, { local: true });
        return copy(rec);
      });
    },
    deleteCategory(id) {
      return enqueue(async () => {
        const c = cats.get(id);
        if (!c) throw new Error('找不到这个分类');
        if (c.deleted) return;
        await commit({ categories: [markDeleted(c, now())] }, { local: true });
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
          await commit({ transactions: plan.txs, categories: plan.newCategories }, { local: true });
        }
        return { imported: plan.imported, skipped: plan.skipped };
      });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 只有用户的写入（记账、删除、还原、分类、导入）才触发；同步方法不触发（避免上传→通知→再上传）。 */
    onLocalWrite(fn) {
      localListeners.add(fn);
      return () => localListeners.delete(fn);
    },

    // ---------- 给同步用（2e）。都走 enqueue，与用户的写入串行 ----------

    /** 待上传：dirty 1 且没有 sync_error（含已删除）。回复制品。 */
    pendingRows(table) {
      return enqueue(async () => [...mapOf(table).values()]
        .filter((r) => r.dirty === 1 && !r.sync_error).map((r) => ({ ...r })));
    },

    /**
     * 上传成功后写回。sent：送出的列；returned：服务器回传的列（只看 id、updated_at）。
     * 本地 updated_at 仍等于送出时才处理（上传途中用户又改过 → 保持待上传）：dirty 0、清 sync_error；
     * 回传时间（正规化后）不同 → 写回服务器的值（时钟快被压回）。不在 returned 里（LWW 略过）也清 dirty。
     * 一次写入；只有 updated_at 改了才通知画面。
     */
    markUploaded(table, sent, returned) {
      return enqueue(async () => {
        const map = mapOf(table);
        const back = new Map((returned || []).map((r) => [r.id, r]));
        const out = [];
        let visible = false;
        for (const s of sent) {
          const local = map.get(s.id);
          if (!local || local.updated_at !== s.updated_at) continue;
          const rec = { ...withoutSyncError(local), dirty: 0 };
          let changed = local.dirty !== 0 || !!local.sync_error;
          const r = back.get(s.id);
          if (r) {
            const ts = normalizeTs(r.updated_at);
            if (ts === null) console.warn(`[store] 回传时间看不懂（${table}），保留本地值`);
            else if (ts !== local.updated_at) { rec.updated_at = ts; visible = true; changed = true; }
          }
          if (changed) out.push(rec);
        }
        if (out.length) await commit({ [table]: out }, { silent: !visible });
      });
    },

    /** 标记坏资料（服务器回 22xxx / 23xxx）。sentUpdatedAt 必填：本地已改过（或没传）→ 不标。dirty 保持 1。 */
    markSyncError(table, id, code, sentUpdatedAt) {
      return enqueue(async () => {
        const local = mapOf(table).get(id);
        if (!local || local.dirty !== 1) return;
        if (typeof sentUpdatedAt !== 'string' || local.updated_at !== sentUpdatedAt) return;
        await commit({ [table]: [{ ...local, sync_error: { code: String(code), at: now().toISOString() } }] }, { silent: true });
      });
    },

    /** 清掉所有 sync_error（App 版本变了重试一次）。回清掉的笔数。 */
    clearSyncErrors() {
      return enqueue(async () => {
        const changes = {};
        let n = 0;
        for (const t of TABLES) {
          const rows = [...mapOf(t).values()].filter((r) => r.sync_error).map(withoutSyncError);
          if (rows.length) { changes[t] = rows; n += rows.length; }
        }
        if (n) await commit(changes, { silent: true });
        return n;
      });
    },

    /** pending：待上传（两表合计，含删除）；errors：有 sync_error。tx*：只数账目（设置页显示用）。 */
    syncCounts() {
      const count = (map) => {
        let p = 0, e = 0;
        for (const r of map.values()) {
          if (r.sync_error) e++;
          else if (r.dirty === 1) p++;
        }
        return [p, e];
      };
      const [tp, te] = count(txs);
      const [cp, ce] = count(cats);
      return { pending: tp + cp, errors: te + ce, txPending: tp, txErrors: te };
    },

    /**
     * 认领：所有列标 dirty 1（不改 updated_at）；账目 id 不是小写 uuid 的换 key
     * （大写 uuid 转小写；非 uuid 或转小写会撞到已有 key → 换新 uuid）。meta 同一次写入（owner_user_id）。
     */
    markAllForUpload({ meta } = {}) {
      return enqueue(async () => {
        const outTx = [];
        const removeTx = [];
        const taken = new Set(txs.keys());
        for (const t of txs.values()) {
          let id = t.id;
          if (!(isUuid(id) && id === id.toLowerCase())) {
            const low = isUuid(id) ? id.toLowerCase() : null;
            id = low && !taken.has(low) ? low : uuid();
            while (taken.has(id)) id = uuid();
            taken.add(id);
            removeTx.push(t.id);
          }
          if (id !== t.id || t.dirty !== 1) outTx.push({ ...t, id, dirty: 1 });
        }
        const outCat = [...cats.values()].filter((c) => c.dirty !== 1).map((c) => ({ ...c, dirty: 1 }));
        const changes = {};
        if (outTx.length) changes.transactions = outTx;
        if (outCat.length) changes.categories = outCat;
        if (removeTx.length) changes.remove = { transactions: removeTx };
        if (meta) changes.meta = meta;
        if (Object.keys(changes).length) await commit(changes, { silent: removeTx.length === 0 });
      });
    },
  };
  return api;
}
