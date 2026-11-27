// 3e 资料库 v1 → v2（加关键词表）：按 oldVersion 分段升级、blocked 先等、旧程式开新资料库的讯息、未知的表要报错。
// 用假的 indexedDB（行为照规范：已存在的 store 再建会丢 ConstraintError）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, STORES } from '../js/db.js';

function fakeIdb({ existing = [] } = {}) {
  const log = [];
  const names = new Set(existing);
  const db = {
    objectStoreNames: { contains: (n) => names.has(n) },
    createObjectStore(n, opts) {
      if (names.has(n)) { const e = new Error(`store ${n} 已存在`); e.name = 'ConstraintError'; throw e; }
      names.add(n);
      log.push(`store ${n} ${opts && opts.keyPath}`);
      return { createIndex: (i) => log.push(`index ${n}.${i}`) };
    },
    transaction() { throw new Error('不该用到'); },
    close() { log.push('close'); },
  };
  const reqs = [];
  return {
    log, names, db, reqs,
    idb: { open(name, version) { const req = { name, version, result: db, error: null }; reqs.push(req); return req; } },
  };
}

function fakeTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; pending.push(t); return t; },
    clearTimer: (t) => { if (t) t.done = true; },
    fire: () => { for (const t of pending) if (!t.done) { t.done = true; t.fn(); } },
  };
}

test('STORES：三张资料表', () => {
  assert.deepEqual(STORES, ['transactions', 'categories', 'category_keywords']);
});

test('全新安装（oldVersion 0）：建 v1 的表＋关键词表，版本 2', async () => {
  const f = fakeIdb();
  const p = openDatabase('t', { idb: f.idb });
  const req = f.reqs[0];
  assert.equal(req.version, 2);
  req.onupgradeneeded({ oldVersion: 0 });
  req.onsuccess();
  await p;
  assert.deepEqual(f.log, [
    'store transactions id', 'index transactions.occurred_on', 'index transactions.dirty',
    'store categories id', 'store meta key', 'store category_keywords id',
  ]);
});

test('旧用户（oldVersion 1）：只建关键词表，旧表不动（不会 ConstraintError）', async () => {
  const f = fakeIdb({ existing: ['transactions', 'categories', 'meta'] });
  const p = openDatabase('t', { idb: f.idb });
  f.reqs[0].onupgradeneeded({ oldVersion: 1 });
  f.reqs[0].onsuccess();
  await p;
  assert.deepEqual(f.log, ['store category_keywords id']);
});

test('防呆：关键词表已经在（例如中断过）也不会再建', async () => {
  const f = fakeIdb({ existing: ['transactions', 'categories', 'meta', 'category_keywords'] });
  const p = openDatabase('t', { idb: f.idb });
  f.reqs[0].onupgradeneeded({ oldVersion: 1 });
  f.reqs[0].onsuccess();
  await p;
  assert.deepEqual(f.log, []);
});

test('blocked（别的分页开着旧连线）：先等，等待期间 success 就正常开', async () => {
  const f = fakeIdb({ existing: ['transactions', 'categories', 'meta'] });
  const t = fakeTimers();
  const p = openDatabase('t', { idb: f.idb, setTimer: t.setTimer, clearTimer: t.clearTimer });
  f.reqs[0].onblocked();
  f.reqs[0].onupgradeneeded({ oldVersion: 1 });
  f.reqs[0].onsuccess();
  const adapter = await p;
  assert.equal(typeof adapter.write, 'function');
  t.fire(); // 计时器已清掉，不会再 reject
  assert.ok(!f.log.includes('close'));
});

test('blocked 等 8 秒还没开 → 显示「请关闭其他分页」；之后才开成功 → 连线马上关掉（不留没人管的连线）', async () => {
  const f = fakeIdb({ existing: ['transactions', 'categories', 'meta'] });
  const t = fakeTimers();
  let waitMs = null;
  const p = openDatabase('t', { idb: f.idb, setTimer: (fn, ms) => { waitMs = ms; return t.setTimer(fn, ms); }, clearTimer: t.clearTimer });
  f.reqs[0].onblocked();
  assert.equal(waitMs, 8000);
  t.fire();
  await assert.rejects(p, /资料库被其他分页占用/);
  f.reqs[0].onupgradeneeded({ oldVersion: 1 });
  f.reqs[0].onsuccess();
  assert.equal(f.log.at(-1), 'close');
});

test('旧程式遇到新资料库（VersionError）→ 请用户重新整理更新', async () => {
  const f = fakeIdb();
  const p = openDatabase('t', { idb: f.idb });
  f.reqs[0].error = Object.assign(new Error('version'), { name: 'VersionError' });
  f.reqs[0].onerror();
  await assert.rejects(p, /新版本/);
});

test('write：不认识的资料键 → 报错（不会静默丢掉）', async () => {
  const f = fakeIdb();
  const p = openDatabase('t', { idb: f.idb });
  f.reqs[0].onupgradeneeded({ oldVersion: 0 });
  f.reqs[0].onsuccess();
  const adapter = await p;
  assert.throws(() => adapter.write({ keywords: [{ id: 'x' }] }), /keywords/);
});
