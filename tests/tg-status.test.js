// 3b-10：设置页 Telegram 状态快取（js/tg-status.js，照 owner-check.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTgStatus, refreshTgStatus, TG_STATUS_KEY, TG_STATUS_MS } from '../js/tg-status.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

const T0 = Date.parse('2026-11-26T10:00:00Z');
const S = (id) => ({ access_token: `at-${id}`, refresh_token: 'r', expires_at: T0 + 3600e3, user_id: id, email: `${id}@x.invalid` });

async function mk({ session = S('u-A') } = {}) {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  if (session) await store.setMetas({ session });
  return store;
}
function opts(store, { status = { ok: true, data: { linked: true, label: '@zed' } }, online = true, now = T0, got } = {}) {
  const calls = [];
  return {
    calls,
    o: {
      fetchFn: () => { throw new Error('不该直接 fetch'); }, userId: 'u-A', now: () => now, isOnline: () => online,
      getSession: async () => got ?? { session: S('u-A') },
      tgLinkFn: async (f, token, action) => { calls.push([token, action]); return typeof status === 'function' ? status() : status; },
    },
  };
}

test('常数：tgStatus、5 分钟', () => {
  assert.equal(TG_STATUS_KEY, 'tgStatus');
  assert.equal(TG_STATUS_MS, 5 * 60 * 1000);
});

test('refreshTgStatus：问 status、存快取（绑账号）、回 {linked, label}；readTgStatus 读得到', async () => {
  const store = await mk();
  const { o, calls } = opts(store);
  assert.deepEqual(await refreshTgStatus(store, o), { linked: true, label: '@zed' });
  assert.deepEqual(calls, [['at-u-A', 'status']]);
  assert.deepEqual(await readTgStatus(store, 'u-A'), { linked: true, label: '@zed' });
  assert.equal(await readTgStatus(store, 'u-B'), null, '别的账号的快取当没有');
});

test('refreshTgStatus：5 分钟内不再问；force 照问；超过 5 分钟再问', async () => {
  const store = await mk();
  const a = opts(store);
  await refreshTgStatus(store, a.o);
  const b = opts(store, { now: T0 + TG_STATUS_MS - 1 });
  assert.equal(await refreshTgStatus(store, b.o), null);
  assert.equal(b.calls.length, 0);
  const c = opts(store, { now: T0 + 1000, status: { ok: true, data: { linked: false } } });
  assert.deepEqual(await refreshTgStatus(store, { ...c.o, force: true }), { linked: false, label: '' });
  assert.equal(c.calls.length, 1);
  const d = opts(store, { now: T0 + 1000 + TG_STATUS_MS });
  await refreshTgStatus(store, d.o);
  assert.equal(d.calls.length, 1);
});

test('refreshTgStatus：离线、拿不到 session、session 是别的账号、服务器失败 → null、快取不动', async () => {
  const cases = [
    { online: false },
    { got: { invalid: true } },
    { got: { session: S('u-B') } },
    { status: { ok: false, status: 500, code: null, error: 'x', retry: true } },
    { status: { ok: true, data: { linked: 'yes' } } },
  ];
  for (const c of cases) {
    const store = await mk();
    const { o } = opts(store, c);
    assert.equal(await refreshTgStatus(store, o), null, JSON.stringify(c));
    assert.equal(await store.getMeta(TG_STATUS_KEY), undefined);
  }
});

test('refreshTgStatus：回应晚到、途中换了账号 → 不写', async () => {
  const store = await mk();
  const { o } = opts(store, { status: async () => { await store.setMetas({ session: S('u-B') }); return { ok: true, data: { linked: true, label: 'x' } }; } });
  assert.equal(await refreshTgStatus(store, o), null);
  assert.equal(await store.getMeta(TG_STATUS_KEY), undefined);
});

test('refreshTgStatus：同时叫两次 → 只问一次', async () => {
  const store = await mk();
  const { o, calls } = opts(store);
  const [a, b] = await Promise.all([refreshTgStatus(store, o), refreshTgStatus(store, o)]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
});

test('审核：旧的回应晚到，不会盖掉之后 force 写入的新结果', async () => {
  const store = await mk();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = opts(store, { now: T0, status: async () => { await gate; return { ok: true, data: { linked: true, label: '旧' } }; } });
  const p = refreshTgStatus(store, slow.o);
  await new Promise((r) => setTimeout(r, 0));
  const fast = opts(store, { now: T0 + 1000, status: { ok: true, data: { linked: false } } });
  assert.deepEqual(await refreshTgStatus(store, { ...fast.o, force: true }), { linked: false, label: '' });
  release();
  assert.equal(await p, null);
  assert.deepEqual(await readTgStatus(store, 'u-A'), { linked: false, label: '' });
});
