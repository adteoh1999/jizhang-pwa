// 2e 任务 6：设置页同步状态文字（js/ui/settings.js syncLabel）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncLabel } from '../js/ui/settings.js';

const S = (o = {}) => ({ state: 'idle', pending: 0, errors: 0, txPending: 0, txErrors: 0, retryInMs: 0, ...o });
const L = (o, opt) => { const r = syncLabel(S(o), opt); return [r.text, r.action]; };

test('已同步 / 待上传', () => {
  assert.deepEqual(L({}), ['已同步', null]);
  assert.deepEqual(L({ txPending: 2, pending: 2 }), ['待上传 2 笔', null]);
  assert.deepEqual(L({ pending: 1 }), ['待上传', null]); // 只有分类待传
});

test('同步中：超过 1 秒才显示（showSyncing），否则照目前笔数显示', () => {
  assert.deepEqual(L({ state: 'syncing', txPending: 3, pending: 3 }, { showSyncing: true }), ['同步中…', null]);
  assert.deepEqual(L({ state: 'syncing', txPending: 3, pending: 3 }), ['待上传 3 笔', null]);
  assert.deepEqual(L({ state: 'syncing' }), ['已同步', null]);
});

test('离线 / 稍后重试', () => {
  assert.deepEqual(L({ state: 'offline', txPending: 1, pending: 1 }), ['离线 · 待上传 1 笔', null]);
  assert.deepEqual(L({ state: 'offline' }), ['离线', null]);
  assert.deepEqual(L({ state: 'error', txPending: 4, pending: 4 }), ['稍后重试 · 待上传 4 笔', null]);
  assert.deepEqual(L({ state: 'error' }), ['稍后重试', null]);
});

test('无法同步优先（可点进去看明细）', () => {
  assert.deepEqual(L({ state: 'error', errors: 2, txErrors: 2 }), ['有 2 笔无法同步', 'errors']);
  assert.deepEqual(L({ state: 'offline', errors: 1, txErrors: 1 }), ['有 1 笔无法同步', 'errors']);
});

test('登录已过期最优先；其他状态', () => {
  assert.deepEqual(L({ state: 'signed-out', errors: 3 }), ['登录已过期 · 重新登录', 'relogin']);
  assert.deepEqual(L({ state: 'other-owner' }), ['账本属于另一个账号', null]);
  assert.deepEqual(L({ state: 'unclaimed' }), ['尚未开始同步 · 开始', 'start']);
  assert.deepEqual(L({ state: 'stale' }), ['账号已更换 · 重新整理', 'reload']);
});

// ---------- 无法同步的明细、重新登录 ----------
import { syncErrorMessage } from '../js/ui/settings.js';
import { forgetSession, saveSession, loadSession } from '../js/auth.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { readFileSync } from 'node:fs';

test('syncErrorMessage：列出日期、分类、金额，提示「修改这笔后会重新上传」；超过 8 笔只列 8 笔', () => {
  const cat = (id) => ({ food: { name: '餐饮' } }[id]);
  const rows = [{ occurred_on: '2026-11-20', category_id: 'food', amount_minor: 1250, kind: 'expense' }];
  const m = syncErrorMessage(rows, cat);
  assert.match(m, /修改这笔后会重新上传/);
  assert.match(m, /2026-11-20/);
  assert.match(m, /餐饮/);
  assert.match(m, /12\.50/);
  const many = Array.from({ length: 11 }, () => rows[0]);
  const m2 = syncErrorMessage(many, cat);
  assert.equal((m2.match(/餐饮/g) || []).length, 8);
  assert.match(m2, /还有 3 笔/);
  assert.match(syncErrorMessage([{ ...rows[0], category_id: 'gone' }], cat), /未分类/);
});

test('store.syncErrorRows：只回有 sync_error 的账目（复制品）', async () => {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  const a = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 2, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.markSyncError('transactions', a.id, '23514', a.updated_at);
  const rows = store.syncErrorRows();
  assert.deepEqual(rows.map((r) => r.id), [a.id]);
});

test('forgetSession：清 session（重新登录用，不通知服务器），走 jizhang-auth 锁', async () => {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  await saveSession(store, { access_token: 'a', refresh_token: 'r', expires_at: 1, user_id: 'u', email: 'e', invalid: true });
  const used = [];
  const locks = { request: (name, fn) => { used.push(name); return fn(); } };
  await forgetSession(store, { locks });
  assert.equal(await loadSession(store), null);
  assert.deepEqual(used, ['jizhang-auth']);
});

test('设置页接线：同步列、登出带 fetchFn 与 stopSync、「正在登出…」、关于不再说只存在这台设备', () => {
  const s = readFileSync(new URL('../js/ui/settings.js', import.meta.url), 'utf8');
  assert.match(s, /syncLabel\(/);
  assert.match(s, /stopSync/);
  assert.match(s, /正在登出…/);
  assert.doesNotMatch(s, /数据只存在这台设备/);
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /createSync\(/);
  assert.match(app, /\.start\(\)/);
  assert.match(app, /ensureClaimed\(/);
  assert.match(app, /schedule\(\{ force: true \}\)/);
});

test('版本 v2.6：version.js 与 sw.js 相同', () => {
  const v = readFileSync(new URL('../js/version.js', import.meta.url), 'utf8').match(/'(v[^']+)'/)[1];
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(v, /^v2\.6-/);
  assert.ok(sw.includes(`'${v}'`));
});
