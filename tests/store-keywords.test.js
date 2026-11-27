// 3e：store 管关键词（第三张表）。新增、改名、删除、复活、同步写回、换账号与清空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { ValidationError } from '../js/model.js';
import { upsertRows } from '../js/rest.js';

let clock = Date.parse('2026-11-27T10:00:00.000Z');
const now = () => new Date(clock);
async function setup() {
  let n = 0;
  const db = createMemoryDb();
  const store = createStore({ db, now, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  await store.init();
  return { db, store };
}
const field = (e) => e instanceof ValidationError && e.field;

test('新增：正规化后存、列出（按关键词排序、不含已删除）、触发本地写入', async () => {
  const { db, store } = await setup();
  let local = 0;
  store.onLocalWrite(() => local++);
  const rec = await store.saveKeyword({ keyword: ' MRT ', categoryId: 'transport' });
  await store.saveKeyword({ keyword: 'Grab', categoryId: 'transport' });
  assert.equal(rec.keyword, 'mrt');
  assert.deepEqual(store.keywords().map((k) => [k.keyword, k.category_id]), [['grab', 'transport'], ['mrt', 'transport']]);
  assert.ok(Object.isFrozen(store.keywords()[0]));
  assert.equal(local, 2);
  const saved = await db.getAll('category_keywords');
  assert.equal(saved.find((r) => r.id === 'grab').dirty, 1);
});

test('分类不存在或已删除 → category 错误，什么都没写', async () => {
  const { db, store } = await setup();
  await assert.rejects(store.saveKeyword({ keyword: 'grab', categoryId: 'nope' }), (e) => field(e) === 'category');
  await store.deleteCategory('fun');
  await assert.rejects(store.saveKeyword({ keyword: 'netflix', categoryId: 'fun' }), (e) => field(e) === 'category');
  assert.deepEqual(await db.getAll('category_keywords'), []);
});

test('检查不过 → keyword-<原因>（空白、太长、重复、满 200）', async () => {
  const { store } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await assert.rejects(store.saveKeyword({ keyword: '  ', categoryId: 'food' }), (e) => field(e) === 'keyword-empty');
  await assert.rejects(store.saveKeyword({ keyword: 'x'.repeat(21), categoryId: 'food' }), (e) => field(e) === 'keyword-long');
  await assert.rejects(store.saveKeyword({ keyword: 'GRAB', categoryId: 'food' }), (e) => field(e) === 'keyword-dup');
  for (let i = 1; i < 200; i++) await store.saveKeyword({ keyword: `k${i}`, categoryId: 'food' });
  assert.equal(store.keywords().length, 200);
  await assert.rejects(store.saveKeyword({ keyword: 'one-more', categoryId: 'food' }), (e) => field(e) === 'keyword-limit');
  // 满了还可以改名、改分类
  await store.saveKeyword({ keyword: 'k1-new', categoryId: 'food', previous: 'k1' });
  await store.saveKeyword({ keyword: 'grab', categoryId: 'food', previous: 'grab' });
  assert.equal(store.keywords().length, 200);
});

test('改名：旧的标删除＋新的写入，同一次写入', async () => {
  const { db, store } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  const before = db.calls.length;
  await store.saveKeyword({ keyword: 'grabcar', categoryId: 'transport', previous: 'grab' });
  assert.equal(db.calls.length, before + 1);
  const all = await db.getAll('category_keywords');
  assert.equal(all.find((r) => r.id === 'grab').deleted, true);
  assert.equal(all.find((r) => r.id === 'grab').dirty, 1);
  assert.equal(all.find((r) => r.id === 'grabcar').deleted, false);
  assert.deepEqual(store.keywords().map((k) => k.keyword), ['grabcar']);
});

test('改名撞到别的关键词 → keyword-dup，两个都不变', async () => {
  const { db, store } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.saveKeyword({ keyword: 'mrt', categoryId: 'transport' });
  const snap = JSON.stringify(await db.getAll('category_keywords'));
  await assert.rejects(store.saveKeyword({ keyword: 'mrt', categoryId: 'food', previous: 'grab' }), (e) => field(e) === 'keyword-dup');
  assert.equal(JSON.stringify(await db.getAll('category_keywords')), snap);
});

test('删除后再加回：同一列复活、updated_at 变大（LWW 盖得过删除）', async () => {
  const { store, db } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.deleteKeyword('grab');
  const del = (await db.getAll('category_keywords'))[0];
  assert.equal(del.deleted, true);
  assert.deepEqual(store.keywords(), []);
  await store.saveKeyword({ keyword: 'grab', categoryId: 'food' });
  const back = (await db.getAll('category_keywords'))[0];
  assert.equal(back.deleted, false);
  assert.equal(back.category_id, 'food');
  assert.ok(back.updated_at > del.updated_at);
});

test('applyRemote：关键词列 id＝keyword（服务器原字串）、LWW 照旧、只有非字串／空字串才跳过', async () => {
  const { store } = await setup();
  await store.setMetas({ owner_user_id: 'u1' });
  const rows = [
    { id: 'grab', keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T09:00:00.000Z', deleted: false, server_updated_at: 's' },
    // 别台设备的 Unicode 规则可能不同：服务器收了就照收（不然这台看不到也删不掉）
    { id: 'Straße', keyword: 'Straße', category_id: 'food', updated_at: '2026-11-27T09:00:00.000Z', deleted: false, server_updated_at: 's' },
    { id: '', keyword: '', category_id: 'food', updated_at: '2026-11-27T09:00:00.000Z', deleted: false, server_updated_at: 's' },
    { id: 7, keyword: 7, category_id: 'food', updated_at: '2026-11-27T09:00:00.000Z', deleted: false, server_updated_at: 's' },
  ];
  assert.equal(await store.applyRemote('category_keywords', rows, { owner: 'u1' }), 2);
  assert.deepEqual(store.keywords().map((k) => [k.id, k.keyword]), [['Straße', 'Straße'], ['grab', 'grab']]);
  // 本地较新 → 服务器较旧的不盖
  await store.saveKeyword({ keyword: 'grab', categoryId: 'food', previous: 'grab' });
  await store.applyRemote('category_keywords', [{ ...rows[0], category_id: 'bills' }], { owner: 'u1' });
  assert.equal(store.keywords().find((k) => k.id === 'grab').category_id, 'food');
});

test('审核 I-2：服务器拉回、写法不标准的关键词（夹零宽字元）→ 这台也删得掉、改得了', async () => {
  const { store, db } = await setup();
  await store.setMetas({ owner_user_id: 'u1' });
  const raw = 'gr\u200Bab';
  await store.applyRemote('category_keywords', [{ id: raw, keyword: raw, category_id: 'transport', updated_at: '2026-11-27T09:00:00.000Z', deleted: false }], { owner: 'u1' });
  assert.deepEqual(store.keywords().map((k) => k.keyword), [raw]);
  // 改分类（UI 传原字串当 previous）→ 旧的标删除、存成正规化的 grab
  await store.saveKeyword({ keyword: raw, categoryId: 'food', previous: raw });
  assert.deepEqual(store.keywords().map((k) => [k.keyword, k.category_id]), [['grab', 'food']]);
  assert.equal((await db.getAll('category_keywords')).find((r) => r.id === raw).deleted, true);
  // 另一个直接删除
  const raw2 = 'mr\u200Bt';
  await store.applyRemote('category_keywords', [{ id: raw2, keyword: raw2, category_id: 'transport', updated_at: '2026-11-27T09:00:00.000Z', deleted: false }], { owner: 'u1' });
  await store.deleteKeyword(raw2);
  assert.deepEqual(store.keywords().map((k) => k.keyword), ['grab']);
});

test('拉回来的关键词再上传：body 不含 id（服务器没有 id 栏）', async () => {
  const { store } = await setup();
  await store.setMetas({ owner_user_id: 'u1' });
  await store.applyRemote('category_keywords', [{ id: 'grab', keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T09:00:00.000Z', deleted: false }], { owner: 'u1' });
  await store.saveKeyword({ keyword: 'grab', categoryId: 'food', previous: 'grab' });
  const pend = await store.pendingRows('category_keywords');
  let body = null;
  await upsertRows(async (_u, init) => { body = JSON.parse(init.body); return { status: 200, json: async () => [] }; }, 'category_keywords', pend, 'tok');
  assert.deepEqual(body, [{ keyword: 'grab', category_id: 'food', updated_at: pend[0].updated_at, deleted: false }]);
});

test('同步计数、有没有资料、没上传的东西、无法同步明细都算进关键词', async () => {
  const { store } = await setup();
  assert.equal(store.hasOwnedData(), false);
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  assert.equal(store.hasOwnedData(), true);
  assert.deepEqual(store.syncCounts(), { pending: 1, errors: 0, txPending: 0, txErrors: 0 });
  assert.equal(store.unsyncedInfo().any, true);
  const k = (await store.pendingRows('category_keywords'))[0];
  await store.setMetas({ owner_user_id: 'u1' });
  await store.markSyncError('category_keywords', 'grab', '23514', k.updated_at, { owner: 'u1' });
  assert.deepEqual(store.syncCounts(), { pending: 0, errors: 1, txPending: 0, txErrors: 0 });
  assert.deepEqual(store.syncErrorRows().kws.map((r) => r.keyword), ['grab']);
  assert.equal(await store.clearSyncErrors({ owner: 'u1' }), 1);
});

test('换账号（resetForAccount）、清空（wipeLocal）：关键词与它的游标一起清掉', async () => {
  const { store, db } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  await store.setMetas({ 'cursor:category_keywords': { ts: 'x', id: 'grab', at: 1 } });
  await store.resetForAccount('u2');
  assert.deepEqual(store.keywords(), []);
  assert.deepEqual(await db.getAll('category_keywords'), []);
  assert.equal(await db.getMeta('cursor:category_keywords'), null);
  await store.saveKeyword({ keyword: 'mrt', categoryId: 'transport' });
  await store.wipeLocal();
  assert.deepEqual(store.keywords(), []);
  assert.deepEqual(await db.getAll('category_keywords'), []);
});

test('认领（markAllForUpload）：关键词也标待上传', async () => {
  const { store, db } = await setup();
  await store.setMetas({ owner_user_id: 'u1' });
  await store.applyRemote('category_keywords', [{ id: 'grab', keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T09:00:00.000Z', deleted: false }], { owner: 'u1' });
  await store.setMetas({ owner_user_id: null });
  assert.equal((await db.getAll('category_keywords'))[0].dirty, 0);
  await store.markAllForUpload({ meta: { owner_user_id: 'u1' } });
  assert.equal((await db.getAll('category_keywords'))[0].dirty, 1);
});

test('init 与 reloadFromDb 读进关键词', async () => {
  const { db, store } = await setup();
  await store.saveKeyword({ keyword: 'grab', categoryId: 'transport' });
  const again = createStore({ db, now });
  await again.init();
  assert.deepEqual(again.keywords().map((k) => k.keyword), ['grab']);
  await store.saveKeyword({ keyword: 'mrt', categoryId: 'transport' });
  assert.equal(await again.reloadFromDb(), 'ok');
  assert.deepEqual(again.keywords().map((k) => k.keyword), ['grab', 'mrt']);
});
