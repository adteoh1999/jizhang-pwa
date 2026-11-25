// 2e-2 任务 8：合并规则（js/merge.js）、store.applyRemote / markMissingForUpload、rest.selectPage 网址
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTakeRemote } from '../js/merge.js';
import { selectPage, UPLOAD_COLUMNS } from '../js/rest.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';

const L = (o) => ({ id: 'x', updated_at: '2026-11-25T10:00:00.000Z', dirty: 0, ...o });
const R = (o) => ({ id: 'x', updated_at: '2026-11-25T10:00:00.000000+00:00', ...o });

// ---------- shouldTakeRemote（审核 M1：不看时钟） ----------
test('shouldTakeRemote：没有本地列 → 采用', () => {
  assert.equal(shouldTakeRemote(undefined, R()), true);
});
test('shouldTakeRemote：本地 dirty，远端严格较新 → 采用；相同或较旧 → 不采用', () => {
  assert.equal(shouldTakeRemote(L({ dirty: 1 }), R({ updated_at: '2026-11-25T10:00:00.001+00:00' })), true);
  assert.equal(shouldTakeRemote(L({ dirty: 1 }), R()), false);
  assert.equal(shouldTakeRemote(L({ dirty: 1 }), R({ updated_at: '2026-11-25T09:59:59.999+00:00' })), false);
});
test('shouldTakeRemote：本地 dirty（含 sync_error）、远端 server_updated_at 2 天前、updated_at 较旧 → 不覆盖', () => {
  const local = L({ dirty: 1, sync_error: { code: '23514' } });
  assert.equal(shouldTakeRemote(local, R({ updated_at: '2026-11-23T10:00:00+00:00', server_updated_at: '2026-11-23T10:00:00+00:00' })), false);
});
test('shouldTakeRemote：本地不 dirty → 时间不同就采用（含本地时间在未来、远端较旧）；相同 → 不采用', () => {
  assert.equal(shouldTakeRemote(L(), R({ updated_at: '2026-11-25T10:00:01+00:00' })), true);
  assert.equal(shouldTakeRemote(L({ updated_at: '2026-11-27T10:00:00.000Z' }), R()), true);
  assert.equal(shouldTakeRemote(L(), R()), false);
});
test('shouldTakeRemote：远端时间带微秒 +00:00 → 正规化后比较；看不懂 → 不采用', () => {
  assert.equal(shouldTakeRemote(L({ updated_at: '2026-11-24T05:02:09.123Z' }), R({ updated_at: '2026-11-24T05:02:09.123456+00:00' })), false);
  assert.equal(shouldTakeRemote(undefined, R({ updated_at: 'garbage' })), false);
  assert.equal(shouldTakeRemote(L(), R({ updated_at: null })), false);
});

// ---------- store.applyRemote ----------
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup() {
  let n = 0;
  let t = Date.parse('2026-11-25T10:00:00.000Z');
  const db = createMemoryDb();
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  await store.setMeta('owner_user_id', 'u-1');
  return { db, store };
}
const remoteTx = (o = {}) => ({
  id: fakeUuid(900), kind: 'expense', amount_minor: 4200, category_id: 'food', occurred_on: '2026-11-21', note: 'r',
  created_at: '2026-11-21T01:02:03.456789+00:00', updated_at: '2026-11-25T12:00:00.123456+00:00', deleted: false,
  server_updated_at: '2026-11-25T12:00:00.223456+00:00', user_id: 'u-1', source: 'app', ...o,
});

test('applyRemote：新列 → 写入、时间正规化、dirty 0、去掉 user_id/server_updated_at/source；cursor 同一次写入', async () => {
  const { db, store } = await setup();
  const before = db.calls.length;
  const n = await store.applyRemote('transactions', [remoteTx()], { meta: { 'cursor:transactions': { ts: 'T', id: 'I' } }, owner: 'u-1' });
  assert.equal(n, 1);
  assert.equal(db.calls.length - before, 1);
  const row = (await db.getAll('transactions'))[0];
  assert.equal(row.updated_at, '2026-11-25T12:00:00.123Z');
  assert.equal(row.created_at, '2026-11-21T01:02:03.456Z');
  assert.equal(row.dirty, 0);
  for (const k of ['user_id', 'server_updated_at', 'source', 'sync_error']) assert.ok(!(k in row), k);
  assert.deepEqual(await store.getMeta('cursor:transactions'), { ts: 'T', id: 'I' });
  assert.equal(store.transactions().length, 1);
});

test('applyRemote：本地 dirty 且较新 → 不覆盖、仍待上传', async () => {
  const { store } = await setup();
  const mine = await store.saveTransaction({ kind: 'expense', amountMinor: 7, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  const n = await store.applyRemote('transactions', [remoteTx({ id: mine.id, updated_at: '2026-11-25T09:00:00+00:00' })], { owner: 'u-1' });
  assert.equal(n, 0);
  assert.equal(store.transactions()[0].amount_minor, 7);
  assert.equal(store.syncCounts().txPending, 1);
});

test('applyRemote：远端较新 → 盖掉本地 dirty 与 sync_error', async () => {
  const { db, store } = await setup();
  const mine = await store.saveTransaction({ kind: 'expense', amountMinor: 7, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markSyncError('transactions', mine.id, '23514', mine.updated_at);
  assert.equal(await store.applyRemote('transactions', [remoteTx({ id: mine.id })], { owner: 'u-1' }), 1);
  const row = (await db.getAll('transactions'))[0];
  assert.equal(row.amount_minor, 4200);
  assert.equal(row.dirty, 0);
  assert.ok(!('sync_error' in row));
});

test('applyRemote：远端 deleted 较新 → 本地也删除、首页不显示', async () => {
  const { store } = await setup();
  await store.applyRemote('transactions', [remoteTx()], { owner: 'u-1' });
  await store.applyRemote('transactions', [remoteTx({ deleted: true, updated_at: '2026-11-25T13:00:00+00:00' })], { owner: 'u-1' });
  assert.equal(store.transactions().length, 0);
});

test('applyRemote：时间看不懂的列跳过（cursor 照写）', async () => {
  const { store } = await setup();
  const n = await store.applyRemote('transactions', [remoteTx({ updated_at: 'bad' }), remoteTx({ id: fakeUuid(901), created_at: 'bad' })],
    { meta: { 'cursor:transactions': { ts: 'T2', id: 'I2' } }, owner: 'u-1' });
  assert.equal(n, 0);
  assert.equal(store.transactions().length, 0);
  assert.deepEqual(await store.getMeta('cursor:transactions'), { ts: 'T2', id: 'I2' });
});

test('applyRemote：没有变化 → 不通知；silent → 不通知；有变化且不 silent → 通知一次', async () => {
  const { store } = await setup();
  let hits = 0;
  store.subscribe(() => hits++);
  await store.applyRemote('transactions', [remoteTx()], { owner: 'u-1', silent: true });
  assert.equal(hits, 0);
  await store.applyRemote('transactions', [remoteTx()], { owner: 'u-1' }); // 相同 → 没变化
  assert.equal(hits, 0);
  await store.applyRemote('transactions', [remoteTx({ updated_at: '2026-11-25T14:00:00Z' })], { owner: 'u-1' });
  assert.equal(hits, 1);
  store.notifyChanged();
  assert.equal(hits, 2);
});

test('applyRemote：owner 已不是这个账号（别的分页换了账号）→ 回 null、什么都不写', async () => {
  const { db, store } = await setup();
  await store.setMeta('owner_user_id', 'u-2');
  const before = db.calls.length;
  assert.equal(await store.applyRemote('transactions', [remoteTx()], { meta: { 'cursor:transactions': { ts: 'T', id: 'I' } }, owner: 'u-1' }), null);
  assert.equal(db.calls.length, before);
  assert.equal(store.transactions().length, 0);
});

test('applyRemote：分类也可以（没有 created_at）', async () => {
  const { store } = await setup();
  const n = await store.applyRemote('categories', [{ id: 'c-new', kind: 'expense', name: '宠物', icon: 'paw', sort: 9, updated_at: '2026-11-25T12:00:00+00:00', deleted: false, server_updated_at: '2026-11-25T12:00:00+00:00' }], { owner: 'u-1' });
  assert.equal(n, 1);
  assert.ok(store.categories('expense').some((c) => c.name === '宠物'));
});

test('applyRemote 写入失败 → reject、快取不变', async () => {
  const { db, store } = await setup();
  db.failNextWrite(new Error('disk'));
  await assert.rejects(store.applyRemote('transactions', [remoteTx()], { owner: 'u-1' }));
  assert.equal(store.transactions().length, 0);
});

// ---------- markMissingForUpload（审核 S9） ----------
test('markMissingForUpload：dirty 0 却不在服务器上的列 → 重新标 dirty；在服务器上的不动；回笔数', async () => {
  const { store } = await setup();
  const a = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  const b = await store.saveTransaction({ kind: 'expense', amountMinor: 2, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
  assert.equal(store.syncCounts().txPending, 0);
  assert.equal(await store.markMissingForUpload('transactions', new Set([a.id]), { owner: 'u-1' }), 1);
  const pending = await store.pendingRows('transactions');
  assert.deepEqual(pending.map((r) => r.id), [b.id]);
  assert.equal(await store.markMissingForUpload('transactions', new Set([a.id]), { owner: 'u-2' }), null);
});

// ---------- selectPage ----------
function recorder(res = () => new Response('[]', { status: 200 })) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return res(); };
  f.calls = calls;
  return f;
}

test('selectPage 完整拉取：GET、栏位、排序、limit 1000、没有 server_updated_at 条件', async () => {
  const f = recorder();
  const r = await selectPage(f, 'transactions', { after: null, since: null }, 'tok');
  assert.deepEqual(r, { status: 200, rows: [], errorCode: null });
  const { url, init } = f.calls[0];
  assert.ok(url.startsWith(`${SUPABASE_URL}/rest/v1/transactions?`));
  const u = new URL(url);
  assert.equal(u.searchParams.get('select'), [...UPLOAD_COLUMNS.transactions, 'server_updated_at'].join(','));
  assert.equal(u.searchParams.get('order'), 'server_updated_at.asc,id.asc');
  assert.equal(u.searchParams.get('limit'), '1000');
  assert.equal(u.searchParams.get('server_updated_at'), null);
  assert.equal(u.searchParams.get('or'), null);
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.apikey, SUPABASE_KEY);
  assert.equal(init.headers.Authorization, 'Bearer tok');
});

test('selectPage 增量：server_updated_at=gt.<since>（编码）', async () => {
  const f = recorder();
  await selectPage(f, 'categories', { after: null, since: '2026-11-25T10:00:00.000Z' }, 'tok');
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('server_updated_at'), 'gt.2026-11-25T10:00:00.000Z');
});

test('selectPage keyset：网址字串锁定（%2B、不含裸 +、值用 %22 包）', async () => {
  const f = recorder();
  const ts = '2026-11-25T10:00:00.123456+00:00';
  const id = '00000000-0000-4000-8000-000000000001';
  await selectPage(f, 'transactions', { after: { ts, id }, since: '2026-11-25T09:00:00.000Z' }, 'tok');
  const url = f.calls[0].url;
  assert.ok(url.includes('%2B'));
  assert.ok(!url.includes('+'));
  assert.ok(url.includes(`or=(server_updated_at.gt.%22${encodeURIComponent(ts)}%22,and(server_updated_at.eq.%22${encodeURIComponent(ts)}%22,id.gt.%22${id}%22))`));
  assert.equal(new URL(url).searchParams.get('server_updated_at'), null); // keyset 页不再加 since
});

test('selectPage：错误回 status 与 code；2xx 非清单 → rows null；网络错 → status 0', async () => {
  let r = await selectPage(recorder(() => new Response(JSON.stringify({ code: 'PGRST103' }), { status: 416 })), 'transactions', {}, 't');
  assert.deepEqual(r, { status: 416, rows: null, errorCode: 'PGRST103' });
  r = await selectPage(recorder(() => new Response('{}', { status: 200 })), 'transactions', {}, 't');
  assert.equal(r.rows, null);
  r = await selectPage(async () => { throw new TypeError('net'); }, 'transactions', {}, 't');
  assert.deepEqual(r, { status: 0, rows: null, errorCode: null });
});

test('selectPage：20 秒超时', async () => {
  let aborted = false;
  const f = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('abort')); }));
  const r = await selectPage(f, 'transactions', {}, 't', { timeoutMs: 10 });
  assert.equal(aborted, true);
  assert.equal(r.status, 0);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../js/rest.js', import.meta.url), 'utf8'), /SELECT_TIMEOUT_MS = 20_000/);
});

test('审核 S-6：keyset 值里的 " 与 \\ 要转义', async () => {
  const f = recorder();
  await selectPage(f, 'categories', { after: { ts: '2026-11-25T10:00:00+00:00', id: 'a"b\\c' } }, 'tok');
  const or = new URL(f.calls[0].url).searchParams.get('or');
  assert.ok(or.includes('id.gt."a\\"b\\\\c"'), or);
});
