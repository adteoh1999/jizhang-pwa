// 3e：同步关键词。顺序（用户 2026-11-27 决定）：分类 → 账目 → 关键词——关键词出错不能连累账目。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync } from '../js/sync.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { syncLabel, syncErrorMessage } from '../js/ui/settings.js';

const ME = 'u-1';
const SESSION = { access_token: 'tok-1', refresh_token: 'r', expires_at: 0, user_id: ME, email: 'me@x.com' };
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const T0 = Date.parse('2026-11-27T10:00:00Z');

// 假服务器：post(table, rows) / get(table, url) 各自可换；记录请求顺序
function fakeServer({ post, get } = {}) {
  const log = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    const method = init.method || 'GET';
    log.push(`${method} ${table}`);
    if (method === 'GET') return get ? get(table, u) : jsonRes(200, []);
    const rows = JSON.parse(init.body);
    if (post) { const r = post(table, rows); if (r) return r; }
    return jsonRes(201, rows.map((r) => ({ id: r.id ?? r.keyword, updated_at: r.updated_at })));
  };
  f.log = log;
  return f;
}

async function setup(server, { fullDone = true } = {}) {
  let n = 0;
  let t = Date.parse('2026-11-27T09:00:00Z');
  const db = createMemoryDb();
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  await store.init();
  await store.setMeta('owner_user_id', ME);
  await store.setMeta('syncErrorVersion', 'v');
  if (fullDone) await store.setMeta('fullSyncAt', T0);
  const sync = createSync({
    store, fetchFn: server, userId: ME, appVersion: 'v',
    getSession: async () => ({ session: SESSION }),
    now: () => T0, setTimer: () => 0, clearTimer: () => {}, isOnline: () => true,
    win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: 'visible' }), locks: null,
  });
  return { db, store, sync };
}
const kwRow = (keyword, category_id = 'transport', extra = {}) => ({
  id: keyword, keyword, category_id, updated_at: '2026-11-27T08:00:00.000Z', deleted: false, server_updated_at: '2026-11-27T08:00:00.000001+00:00', ...extra,
});

test('上传与拉取顺序：分类 → 账目 → 关键词', async () => {
  const server = fakeServer();
  const { store, sync } = await setup(server);
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.saveCategory({ kind: 'expense', name: '宠物', icon: 'other' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-27', note: '' });
  assert.equal(await sync.syncNow(), 'ok');
  assert.deepEqual(server.log, [
    'POST categories', 'POST transactions', 'POST category_keywords',
    'GET categories', 'GET transactions', 'GET category_keywords',
  ]);
  assert.equal(store.syncCounts().pending, 0);
});

test('关键词上传失败（5xx）→ 这轮失败，但账目已经传上去', async () => {
  const server = fakeServer({ post: (table) => (table === 'category_keywords' ? jsonRes(500, { code: 'XX000' }) : null) });
  const { store, sync } = await setup(server);
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-27', note: '' });
  assert.equal(await sync.syncNow(), 'fail');
  assert.equal(store.syncCounts().txPending, 0, '账目已上传');
  assert.equal(store.syncCounts().pending, 1, '关键词还在等');
});

test('关键词拉取 4xx → 这轮失败，但账目已经拉回', async () => {
  const tx = {
    id: '00000000-0000-4000-8000-000000000099', kind: 'expense', amount_minor: 500, category_id: 'food', occurred_on: '2026-11-27', note: '',
    created_at: '2026-11-27T08:00:00.000Z', updated_at: '2026-11-27T08:00:00.000Z', deleted: false, server_updated_at: '2026-11-27T08:00:00.000001+00:00',
  };
  let txServed = false;
  const server = fakeServer({
    get: (table) => {
      if (table === 'transactions') { if (txServed) return jsonRes(200, []); txServed = true; return jsonRes(200, [tx]); }
      if (table === 'category_keywords') return jsonRes(400, { code: 'PGRST100' });
      return jsonRes(200, []);
    },
  });
  const { store, sync } = await setup(server);
  assert.equal(await sync.syncNow(), 'fail');
  assert.deepEqual(store.transactions().map((t) => t.id), [tx.id]);
});

test('拉回关键词：id 是别名、游标存 keyword', async () => {
  let served = false;
  const server = fakeServer({
    get: (table) => {
      if (table !== 'category_keywords' || served) return jsonRes(200, []);
      served = true;
      return jsonRes(200, [kwRow('grab'), kwRow('猫粮', 'shopping')]);
    },
  });
  const { store, sync } = await setup(server);
  assert.equal(await sync.syncNow(), 'ok');
  assert.deepEqual(store.keywords().map((k) => [k.keyword, k.category_id]), [['grab', 'transport'], ['猫粮', 'shopping']]);
  const cur = await store.getMeta('cursor:category_keywords');
  assert.equal(cur.id, '猫粮');
});

test('关键词被服务器拒（23514）→ 只有那一个标无法同步，账目照传', async () => {
  const server = fakeServer({
    post: (table, rows) => (table === 'category_keywords' && rows.some((r) => r.keyword === 'bad') ? jsonRes(400, { code: '23514' }) : null),
  });
  const { store, sync } = await setup(server);
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.saveKeyword({ keyword: 'bad', categoryId: 'transport' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 100, categoryId: 'food', occurredOn: '2026-11-27', note: '' });
  await sync.syncNow();
  assert.deepEqual(store.syncErrorRows().kws.map((k) => k.keyword), ['bad']);
  assert.equal(store.syncCounts().txPending, 0);
  assert.deepEqual(store.syncCounts(), { pending: 0, errors: 1, txPending: 0, txErrors: 0 });
});

test('完整对账：本地已同步、服务器没有的关键词 → 重新标待上传', async () => {
  const server = fakeServer();
  const { store, sync } = await setup(server, { fullDone: false });
  await store.applyRemote('category_keywords', [kwRow('grab')], { owner: ME });
  assert.equal(store.syncCounts().pending, 0);
  await sync.syncNow();
  assert.ok(server.log.filter((x) => x === 'POST category_keywords').length >= 1, '重新上传了');
});

test('设置页：只有分类或关键词出错 → 「有分类或关键词无法同步」；明细列出关键词', () => {
  assert.deepEqual(syncLabel({ state: 'idle', errors: 1, txErrors: 0, txPending: 0 }), { text: '有分类或关键词无法同步', action: 'errors' });
  const msg = syncErrorMessage({ txs: [], cats: [], kws: [{ keyword: 'grab' }] }, () => undefined);
  assert.match(msg, /关键词 · grab/);
});
