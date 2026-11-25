// 资料仓库：记忆体快取 + 串行写入队列。先写 db，成功后才更新快取并通知。
import { uuid as defaultUuid } from './uuid.js';
import {
  defaultCategories, buildTransaction, buildCategory, markDeleted, markRestored, ValidationError, DEFAULT_EPOCH,
} from './model.js';
import { compareTx } from './stats.js';
import { toCSV, parseCSV, planImport } from './csv.js';
import { normalizeTs, isUuid } from './timefmt.js';
import { shouldTakeRemote } from './merge.js';
import { UPLOAD_COLUMNS } from './rest.js';

const TABLES = ['transactions', 'categories'];
// 设备设定（不属于任何账号）：清空本机账本时保留
export const INSTALL_HINT_KEY = 'installHintDismissed';
const DEVICE_META = [INSTALL_HINT_KEY];
const withoutSyncError = (r) => { const { sync_error: _drop, ...rest } = r; return rest; };

export function createStore({ db, now = () => new Date(), uuid = defaultUuid }) {
  const txs = new Map(); // 含已删除
  const cats = new Map(); // 含已删除
  const listeners = new Set();
  const localListeners = new Set(); // 只有用户的写入才通知（同步用来排程上传）
  const ledgerListeners = new Set(); // 账本被别的分页换掉（换账号清除）时通知画面
  let ledgerId = null; // 载入时的账本代号：resetForAccount 每次换新；用户写入时在同一次写入里核对
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

  function ledgerChanged() {
    for (const fn of [...ledgerListeners]) { try { fn(); } catch (err) { console.error(err); } }
  }

  function notifyLocal() {
    for (const fn of [...localListeners]) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
  // 旧引擎写回前核对：owner 给了却已不是 owner_user_id（别的分页换了账号）→ false（审核 5 S-4）
  const ownerOk = async (owner) => owner === undefined || (await db.getMeta('owner_user_id')) === owner;
  // 先读一次（早点发现、不必写），写入时再在同一个 transaction 里核对一次（审核 S-1）。不符 → null
  async function ownerCommit(owner, changes, opts = {}) {
    if (owner === undefined) { await commit(changes, opts); return true; }
    try {
      await commit(changes, { ...opts, expect: { owner_user_id: owner, ledgerId } }); // 账本代号也要相同（复审 2）
      return true;
    } catch (e) {
      if (e && e.name === 'MetaMismatch') return null;
      throw e;
    }
  }
  const mapOf = (table) => {
    if (table === 'transactions') return txs;
    if (table === 'categories') return cats;
    throw new Error(`未知的表：${table}`);
  };

  // 写入 db，成功后套用到快取并通知。local：用户的写入（同步会排程上传）；silent：不通知画面。
  // 用户的写入一律核对账本代号（审核 M-2）：别的分页已清除换账号 → 不写、通知画面、丢 LedgerChanged。
  // expect：额外要核对的 meta（引擎写回核对 owner，审核 S-1：与写入同一个 transaction）。
  async function commit(changes, { local = false, silent = false, expect } = {}) {
    const exp = local ? { ...expect, ledgerId } : expect;
    try {
      await db.write(exp ? { ...changes, expect: exp } : changes);
    } catch (e) {
      if (local && e && e.name === 'MetaMismatch') {
        ledgerChanged();
        const err = new Error('账本已在别的分页换成另一个账号');
        err.name = 'LedgerChanged';
        throw err;
      }
      throw e;
    }
    for (const s of changes.clear || []) mapOf(s).clear();
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
        const [t, c, lid] = await Promise.all([db.getAll('transactions'), db.getAll('categories'), db.getMeta('ledgerId')]);
        txs.clear(); cats.clear();
        ledgerId = lid ?? null;
        for (const r of t) txs.set(r.id, r);
        for (const r of c) cats.set(r.id, r);
        if (cats.size === 0) await commit({ categories: defaultCategories() });
      });
    },

    /**
     * 别的分页拉回资料写进了资料库：重新读进快取并通知画面（2e-3）。
     * 账本代号已变（别的分页换了账号）→ 不换快取、通知 onLedgerChanged，回 'ledger-changed'。
     */
    reloadFromDb() {
      return enqueue(async () => {
        const [t, c, lid] = await Promise.all([db.getAll('transactions'), db.getAll('categories'), db.getMeta('ledgerId')]);
        if ((lid ?? null) !== ledgerId) { ledgerChanged(); return 'ledger-changed'; }
        txs.clear(); cats.clear();
        for (const r of t) txs.set(r.id, r);
        for (const r of c) cats.set(r.id, r);
        notify();
        return 'ok';
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
    /** 一次写多个 meta 键（同一个 IndexedDB transaction：要嘛全有要嘛全无）。 */
    setMetas(obj) {
      return enqueue(async () => {
        await db.write({ meta: { ...obj } });
      });
    },
    /** 有 sync_error 的账目（含已删除）与分类（设置页「无法同步」明细用），复制品。 */
    syncErrorRows() {
      return {
        txs: [...txs.values()].filter((t) => t.sync_error).sort(compareTx).map(copy),
        cats: [...cats.values()].filter((c) => c.sync_error).map(copy),
      };
    },
    /** 这台设备有没有「属于某个人」的资料：任何账目列（含已删除），或自建 / 改过的分类（默认分类不算）。 */
    hasOwnedData() {
      if (txs.size > 0) return true;
      for (const c of cats.values()) if (c.updated_at !== DEFAULT_EPOCH) return true;
      return false;
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
    markUploaded(table, sent, returned, { owner } = {}) {
      return enqueue(async () => {
        if (!(await ownerOk(owner))) return null;
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
        if (out.length && (await ownerCommit(owner, { [table]: out }, { silent: !visible })) === null) return null;
      });
    },

    /** 标记坏资料（服务器回 22xxx / 23xxx）。sentUpdatedAt 必填：本地已改过（或没传）→ 不标。dirty 保持 1。 */
    markSyncError(table, id, code, sentUpdatedAt, { owner } = {}) {
      return enqueue(async () => {
        if (!(await ownerOk(owner))) return null;
        const local = mapOf(table).get(id);
        if (!local || local.dirty !== 1) return;
        if (typeof sentUpdatedAt !== 'string' || local.updated_at !== sentUpdatedAt) return;
        return ownerCommit(owner, { [table]: [{ ...local, sync_error: { code: String(code), at: now().toISOString() } }] }, { silent: true });
      });
    },

    /** 清掉所有 sync_error（App 版本变了重试一次）。回清掉的笔数。 */
    clearSyncErrors({ owner } = {}) {
      return enqueue(async () => {
        if (!(await ownerOk(owner))) return null;
        const changes = {};
        let n = 0;
        for (const t of TABLES) {
          const rows = [...mapOf(t).values()].filter((r) => r.sync_error).map(withoutSyncError);
          if (rows.length) { changes[t] = rows; n += rows.length; }
        }
        if (n && (await ownerCommit(owner, changes, { silent: true })) === null) return null;
        return n;
      });
    },

    /**
     * 套用拉回来的列（2e-2）。在队列里对「当下」的快取逐列判断 shouldTakeRemote；
     * 采用的列只留上传栏位、时间正规化、dirty 0（不带 sync_error）。meta（游标）同一次写入。
     * owner：写入前核对 owner_user_id 还是它，不是 → 回 null、什么都不写（别的分页换了账号）。
     * 回采用笔数；有采用且不 silent 才通知画面。时间看不懂的列跳过。
     */
    applyRemote(table, rows, { meta, owner, silent = false } = {}) {
      return enqueue(async () => {
        if (owner === undefined || !(await ownerOk(owner))) return null;
        const map = mapOf(table);
        const cols = UPLOAD_COLUMNS[table];
        const out = [];
        let skipped = 0;
        for (const r of rows) {
          const rec = Object.fromEntries(cols.map((c) => [c, r[c]]));
          rec.updated_at = normalizeTs(r.updated_at);
          if ('created_at' in rec) rec.created_at = normalizeTs(r.created_at);
          if (rec.updated_at === null || rec.created_at === null || typeof rec.id !== 'string') { skipped++; continue; }
          if (!shouldTakeRemote(map.get(rec.id), r)) continue;
          rec.deleted = rec.deleted === true;
          rec.dirty = 0;
          out.push(rec);
        }
        if (skipped) console.warn(`[store] 拉回 ${table} 有 ${skipped} 笔时间看不懂，跳过`);
        if (!out.length && !meta) return 0;
        const ok = await ownerCommit(owner, { ...(out.length ? { [table]: out } : {}), ...(meta ? { meta } : {}) }, { silent: silent || !out.length });
        return ok === null ? null : out.length;
      });
    },

    /** 完整对账后（审核 S9）：dirty 0 却不在服务器上的列重新标待上传。owner 不符回 null。回笔数。 */
    markMissingForUpload(table, serverIds, { owner } = {}) {
      return enqueue(async () => {
        if (owner === undefined || !(await ownerOk(owner))) return null;
        const out = [...mapOf(table).values()].filter((r) => r.dirty !== 1 && !serverIds.has(r.id)).map((r) => ({ ...r, dirty: 1 }));
        if (out.length && (await ownerCommit(owner, { [table]: out }, { silent: true })) === null) return null;
        return out.length;
      });
    },

    /**
     * 换账号（spec §7.7、审核 M5）：同一次写入清空账与分类、重建默认分类（dirty 1，epoch：传到已有账号会被 LWW 略过）、
     * owner 换成 userId、清游标与完整对账时间（第一轮完整拉取）、清「关掉提醒」。meta：要一起写的（session、lastUserId）。
     * 不清 session 以外的登录资料（loginPending 由登录流程处理）与 localStorage。
     */
    resetForAccount(userId, { meta = {} } = {}) {
      return enqueue(async () => {
        const nextLedger = uuid();
        await commit({
          clear: TABLES,
          categories: defaultCategories().map((c) => ({ ...c, dirty: 1 })),
          meta: {
            ...meta,
            owner_user_id: userId,
            ledgerId: nextLedger,
            'cursor:transactions': null,
            'cursor:categories': null,
            fullSyncAt: null,
            syncPromptDismissed: null,
          },
        });
        ledgerId = nextLedger;
      });
    },

    /**
     * 清空这台设备的账本（2f：登出、删号共用）。同一次写入：清空账、分类与全部 meta，重建默认分类
     * （与全新安装相同、不标待上传），换新 ledgerId（别的分页的旧写入会被挡）。只保留设备设定（安装提示）。
     * 不碰 localStorage（隐藏金额由呼叫的人清）。失败就 reject，资料库与快取都不变。
     */
    wipeLocal() {
      return enqueue(async () => {
        const nextLedger = uuid();
        const keep = {};
        for (const k of DEVICE_META) {
          const v = await db.getMeta(k);
          if (v !== undefined && v !== null) keep[k] = v;
        }
        await commit({ clear: TABLES, clearMeta: true, categories: defaultCategories(), meta: { ...keep, ledgerId: nextLedger } });
        ledgerId = nextLedger;
      });
    },

    /**
     * 换账号前：这台设备还有没有「没上传」的东西（审核 S-2、S-8）。
     * 平常：dirty 或 sync_error 的列（没改过的默认分类不算）；all（还没归属、从没同步过）：整本都算。
     * txCount 只数看得到（没删除）的账目。
     */
    unsyncedInfo({ all = false } = {}) {
      const un = (r) => all || r.dirty === 1 || !!r.sync_error;
      let txCount = 0;
      let any = false;
      for (const t of txs.values()) if (un(t)) { any = true; if (!t.deleted) txCount++; }
      for (const c of cats.values()) if (un(c) && c.updated_at !== DEFAULT_EPOCH) any = true;
      return { any, txCount };
    },

    /** 账本被别的分页换掉时（用户写入被挡）通知。 */
    onLedgerChanged(fn) {
      ledgerListeners.add(fn);
      return () => ledgerListeners.delete(fn);
    },

    /** 通知画面重画（同步一轮结束时有拉回变化才叫一次）。 */
    notifyChanged() { notify(); },

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
        // 认领：账本还是这一本、而且还没有主人才写（别的分页刚清除换账号 → MetaMismatch，复审 3）
        if (Object.keys(changes).length) await commit(changes, { silent: removeTx.length === 0, expect: { ledgerId, owner_user_id: null } });
      });
    },
  };
  return api;
}
