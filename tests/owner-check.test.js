// 2f Task 7：站主判断（每天最多问一次服务器；快取绑账号，审核 M4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { refreshOwnerFlag, readOwnerFlag, OWNER_CHECK_MS, OWNER_FLAG_KEY } from '../js/owner-check.js';
import { adminRows } from '../js/ui/settings.js';
import { SUPABASE_URL } from '../js/config.js';

const FAR = Date.parse('2099-01-01T00:00:00Z');
const NOW = Date.parse('2026-11-25T10:00:00Z');
const sessionOf = (id) => ({ access_token: `tok-${id}`, refresh_token: `ref-${id}`, expires_at: FAR, user_id: id, email: `${id}@example.invalid`, platform: 'pwa' });
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });

async function setup({ session = sessionOf('u-A'), flag, reply = () => res(200, { owner: true }), online = true } = {}) {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session, ...(flag === undefined ? {} : { [OWNER_FLAG_KEY]: flag }) });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: url.replace(SUPABASE_URL, ''), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return reply(url, init);
  };
  const opts = { fetchFn, userId: 'u-A', now: () => NOW, isOnline: () => online };
  return { store, calls, opts };
}

test('200 {owner:true} → 回 true，记下 {userId, value:true, checkedAt}', async () => {
  const { store, calls, opts } = await setup();
  assert.equal(await refreshOwnerFlag(store, opts), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/functions/v1/invites');
  assert.deepEqual(calls[0].body, { action: 'check' });
  assert.equal(calls[0].auth, 'Bearer tok-u-A');
  assert.deepEqual(await store.getMeta(OWNER_FLAG_KEY), { userId: 'u-A', value: true, checkedAt: NOW });
  assert.equal(await readOwnerFlag(store, 'u-A'), true);
});

test('200 {owner:false} → 回 false，记下 value:false', async () => {
  const { store, opts } = await setup({ reply: () => res(200, { owner: false }) });
  assert.equal(await refreshOwnerFlag(store, opts), false);
  assert.deepEqual(await store.getMeta(OWNER_FLAG_KEY), { userId: 'u-A', value: false, checkedAt: NOW });
  assert.equal(await readOwnerFlag(store, 'u-A'), false);
});

test('403 → 当成不是站主（旧版服务器）', async () => {
  const { store, opts } = await setup({ reply: () => res(403, { error: '没有权限' }) });
  assert.equal(await refreshOwnerFlag(store, opts), false);
  assert.equal((await store.getMeta(OWNER_FLAG_KEY)).value, false);
});

test('500 → 回 null，旧值不变、不记时间（下次再问）', async () => {
  const old = { userId: 'u-A', value: true, checkedAt: NOW - OWNER_CHECK_MS - 1 };
  const { store, opts } = await setup({ flag: old, reply: () => res(500, {}) });
  assert.equal(await refreshOwnerFlag(store, opts), null);
  assert.deepEqual(await store.getMeta(OWNER_FLAG_KEY), old);
});

test('401、2xx 但内容不对（owner 不是布尔）、断网 → 都回 null、不写', async () => {
  for (const reply of [() => res(401, {}), () => res(200, { owner: 'yes' }), () => res(200, {}), () => { throw new TypeError('net'); }]) {
    const { store, opts } = await setup({ reply });
    assert.equal(await refreshOwnerFlag(store, opts), null);
    assert.equal(await store.getMeta(OWNER_FLAG_KEY), undefined);
  }
});

test('同一个账号 24 小时内不重查；满 24 小时才再问', async () => {
  const { store, calls, opts } = await setup({ flag: { userId: 'u-A', value: true, checkedAt: NOW - OWNER_CHECK_MS + 1 } });
  assert.equal(await refreshOwnerFlag(store, opts), null);
  assert.equal(calls.length, 0);
  await store.setMeta(OWNER_FLAG_KEY, { userId: 'u-A', value: true, checkedAt: NOW - OWNER_CHECK_MS });
  assert.equal(await refreshOwnerFlag(store, opts), true);
  assert.equal(calls.length, 1);
});

test('检查时间比现在还晚（时钟被调过）→ 当作过期、重查', async () => {
  const { calls, store, opts } = await setup({ flag: { userId: 'u-A', value: false, checkedAt: NOW + 60_000 } });
  assert.equal(await refreshOwnerFlag(store, opts), true);
  assert.equal(calls.length, 1);
});

test('快取是别的账号的：不算数（读出 false）、照样去问（M4）', async () => {
  const { store, calls, opts } = await setup({ flag: { userId: 'u-OLD', value: true, checkedAt: NOW } });
  assert.equal(await readOwnerFlag(store, 'u-A'), false);
  assert.equal(await refreshOwnerFlag(store, opts), true);
  assert.equal(calls.length, 1);
  assert.equal((await store.getMeta(OWNER_FLAG_KEY)).userId, 'u-A');
});

test('离线 → 不问、回 null', async () => {
  const { store, calls, opts } = await setup({ online: false });
  assert.equal(await refreshOwnerFlag(store, opts), null);
  assert.equal(calls.length, 0);
});

test('拿不到可用的登录（失效）→ 不问、回 null', async () => {
  const { store, calls, opts } = await setup({ session: { ...sessionOf('u-A'), invalid: true } });
  assert.equal(await refreshOwnerFlag(store, opts), null);
  assert.equal(calls.length, 0);
});

test('资料库里登录的已经不是这个账号 → 不问、回 null', async () => {
  const { store, calls, opts } = await setup({ session: sessionOf('u-B') });
  assert.equal(await refreshOwnerFlag(store, opts), null);
  assert.equal(calls.length, 0);
  assert.equal(await store.getMeta(OWNER_FLAG_KEY), undefined);
});

test('回应晚到、途中账号已换成 B → 不写（M4）', async () => {
  let store;
  const ctx = await setup({
    reply: async () => {
      await store.setMeta('session', sessionOf('u-B')); // 等回应时别的分页换了账号
      return res(200, { owner: true });
    },
  });
  store = ctx.store;
  assert.equal(await refreshOwnerFlag(store, ctx.opts), null);
  assert.equal(await store.getMeta(OWNER_FLAG_KEY), undefined);
});

test('同时叫两次（回前景＋打开设置页）→ 只问服务器一次，两边拿到同一个结果', async () => {
  const { store, calls, opts } = await setup();
  const [a, b] = await Promise.all([refreshOwnerFlag(store, opts), refreshOwnerFlag(store, opts)]);
  assert.equal(calls.length, 1);
  assert.equal(a, true);
  assert.equal(b, true);
});

test('readOwnerFlag：没有快取、value 不是 true → false', async () => {
  const { store } = await setup();
  assert.equal(await readOwnerFlag(store, 'u-A'), false);
  await store.setMeta(OWNER_FLAG_KEY, { userId: 'u-A', value: 'true', checkedAt: NOW });
  assert.equal(await readOwnerFlag(store, 'u-A'), false);
});

test('设置页：只有站主才有「管理」区的「邀请码管理」', () => {
  assert.deepEqual(adminRows(false), []);
  assert.deepEqual(adminRows(true), [{ kind: 'invites', label: '邀请码管理' }]);
});
