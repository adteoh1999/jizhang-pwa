// 2e 任务 6：设置页同步状态文字（js/ui/settings.js syncLabel）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncLabel, syncDiagText, syncDiagParts } from '../js/ui/settings.js';

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

test('syncErrorMessage：列出账目（日期 · 分类 · 金额，已删除标出）与分类；超过 8 行只列 8 行', () => {
  const cat = (id) => ({ food: { name: '餐饮' } }[id]);
  const tx = { occurred_on: '2026-11-20', category_id: 'food', amount_minor: 1250, kind: 'expense', deleted: false };
  const m = syncErrorMessage({ txs: [tx, { ...tx, deleted: true }], cats: [{ name: '很长的分类' }] }, cat);
  assert.match(m, /修改后会重新上传/);
  assert.match(m, /2026-11-20 · 餐饮 · −RM 12\.50\n/);
  assert.match(m, /已删除/);
  assert.match(m, /分类 · 很长的分类/);
  const m2 = syncErrorMessage({ txs: Array.from({ length: 11 }, () => tx), cats: [] }, cat);
  assert.equal((m2.match(/餐饮/g) || []).length, 8);
  assert.match(m2, /还有 3 项/);
  assert.match(syncErrorMessage({ txs: [{ ...tx, category_id: 'gone' }], cats: [] }, cat), /未分类/);
});

test('只有分类出错 → 「有分类无法同步」；账目与分类都有 → 照账目笔数', () => {
  assert.deepEqual(L({ errors: 1, txErrors: 0 }), ['有分类无法同步', 'errors']);
  assert.deepEqual(L({ errors: 2, txErrors: 1 }), ['有 1 笔无法同步', 'errors']);
});

test('优先顺序：登录过期 → 账号已更换 → 属于另一个账号 → 尚未开始 → 无法同步 → 其余；stopped 显示已停止', () => {
  assert.deepEqual(L({ state: 'stale', errors: 2, txErrors: 2 }), ['账号已更换 · 重新整理', 'reload']);
  assert.deepEqual(L({ state: 'other-owner', errors: 2, txErrors: 2 }), ['账本属于另一个账号', null]);
  assert.deepEqual(L({ state: 'unclaimed', errors: 2, txErrors: 2 }), ['尚未开始同步 · 开始', 'start']);
  assert.deepEqual(L({ state: 'stopped' }), ['已停止', null]);
});

test('store.syncErrorRows：回 {txs, cats}，只有带 sync_error 的（含已删除的账）', async () => {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  const a = await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.saveTransaction({ kind: 'expense', amountMinor: 2, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  await store.deleteTransaction(a.id);
  const del = store.syncErrorRows; // 先确认没有
  assert.deepEqual(del().txs, []);
  const [row] = (await store.pendingRows('transactions')).filter((r) => r.id === a.id);
  await store.markSyncError('transactions', a.id, '23514', row.updated_at);
  const c = await store.saveCategory({ kind: 'expense', name: '宠物' });
  await store.markSyncError('categories', c.id, '23514', c.updated_at);
  const r = store.syncErrorRows();
  assert.deepEqual(r.txs.map((t) => [t.id, t.deleted]), [[a.id, true]]);
  assert.deepEqual(r.cats.map((x) => x.id), [c.id]);
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
  // 登出流程在 2f Task 10 搬到 sign-out.js（行为见 tests/settings-signout.test.js）
  const so = readFileSync(new URL('../js/ui/sign-out.js', import.meta.url), 'utf8');
  assert.match(so, /stopSync/);
  assert.match(so, /正在登出…/);
  assert.match(s, /runSignOut\(/);
  assert.doesNotMatch(s, /数据只存在这台设备/);
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /createSync\(/);
  assert.match(app, /\.start\(\)/);
  assert.match(app, /ensureClaimed\(/);
  assert.match(app, /createClaimRunner\(/);
  assert.match(app, /syncNow\(\)/);
  // 引擎与认领在 mountShell 最后才开始（之前的步骤丢错就不会在错误画面上跑）
  const shell = app.slice(app.indexOf('function mountShell'), app.indexOf('async function boot'));
  assert.ok(shell.lastIndexOf('sync.start()') > shell.indexOf('mountTabBar('));
});

test('版本 v3.0.1：version.js 与 sw.js 相同', () => {
  const v = readFileSync(new URL('../js/version.js', import.meta.url), 'utf8').match(/'(v[^']+)'/)[1];
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(v, /^v3\.0\.1-/);
  assert.ok(sw.includes(`'${v}'`));
});

// ---------- 认领执行器、同步中计时 ----------
import { createClaimRunner } from '../js/sync.js';
import { createSyncLabeler } from '../js/ui/settings.js';

test('createClaimRunner：同时叫两次只跑一次；mine 才 onMine；失败交给 onError，之后还能再叫', async () => {
  let calls = 0;
  let mine = 0;
  const errs = [];
  let result = 'mine';
  let release;
  const run = createClaimRunner({
    ensure: (fromUser) => { calls++; return new Promise((res, rej) => { release = () => (result === 'boom' ? rej(new Error('x')) : res(result)); }); },
    onMine: () => mine++,
    onError: (e, fromUser) => errs.push(fromUser),
  });
  const p1 = run(false);
  const p2 = run(true);
  assert.equal(p1, p2);
  release();
  await p1;
  assert.deepEqual([calls, mine], [1, 1]);
  for (const st of ['unclaimed', 'other']) {
    result = st;
    const p = run(false); release(); await p;
  }
  assert.equal(mine, 1);
  result = 'boom';
  const p3 = run(true); release(); await p3;
  assert.deepEqual(errs, [true]);
  result = 'mine';
  const p4 = run(false); release(); await p4;
  assert.equal(mine, 2);
});

test('createSyncLabeler：同步中未满 1 秒保留上一个文字；满 1 秒才「同步中…」；离开就清计时', () => {
  const timers = new Map();
  let seq = 0;
  let slow = 0;
  const lab = createSyncLabeler({
    setTimer: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; },
    clearTimer: (id) => timers.delete(id),
    onSlow: () => slow++,
  });
  assert.equal(lab.label(S({ state: 'error', txPending: 1, pending: 1 })).text, '稍后重试 · 待上传 1 笔');
  assert.equal(lab.label(S({ state: 'syncing', txPending: 1, pending: 1 })).text, '稍后重试 · 待上传 1 笔');
  assert.equal(timers.size, 1);
  const [[, t]] = [...timers];
  assert.equal(t.ms, 1000);
  t.fn();
  assert.equal(slow, 1);
  assert.equal(lab.label(S({ state: 'syncing', txPending: 1, pending: 1 })).text, '同步中…');
  assert.equal(lab.label(S({ state: 'idle' })).text, '已同步');
  timers.clear();
  lab.label(S({ state: 'syncing' }));
  assert.equal(timers.size, 1);
  lab.label(S({ state: 'idle' }));
  assert.equal(timers.size, 0); // 离开 syncing 就清掉
  lab.label(S({ state: 'syncing' }));
  lab.dispose();
  assert.equal(timers.size, 0);
});

// ---------- 2e-3 Task 3：诊断行 ----------
const at = (h, m, sec) => new Date(2026, 10, 25, h, m, sec).getTime(); // 本地时间
const D = (o = {}) => ({ lastRunAt: null, lastResult: null, failures: 0, runningSince: null, lastAdopted: 0, ...o });

test('诊断行：还没检查 / 连线正常 / 收到 N 笔', () => {
  const now = at(14, 33, 0);
  assert.equal(syncDiagText(D(), { now }), '还没检查');
  assert.equal(syncDiagText(D({ lastRunAt: at(14, 32, 5), lastResult: 'ok' }), { now }), '上次检查 14:32:05 · 连线正常');
  assert.equal(syncDiagText(D({ lastRunAt: at(9, 2, 5), lastResult: 'ok', lastAdopted: 2 }), { now }), '上次检查 09:02:05 · 连线正常 · 收到 2 笔');
});

test('诊断行：失败（连续 N 次）、暂停、另一个分页在同步', () => {
  const now = at(14, 33, 0);
  assert.equal(syncDiagText(D({ lastRunAt: at(14, 32, 5), lastResult: 'fail', failures: 3 }), { now }), '上次检查 14:32:05 · 失败（连续 3 次）');
  assert.equal(syncDiagText(D({ lastRunAt: at(14, 32, 5), lastResult: 'halt' }), { now }), '上次检查 14:32:05 · 暂停');
  assert.equal(syncDiagText(D({ lastRunAt: at(14, 32, 5), lastResult: 'skip' }), { now }), '上次检查 14:32:05 · 另一个分页在同步');
});

test('诊断行：进行中超过 10 秒才显示；即时连线状态', () => {
  const now = at(14, 33, 0);
  const base = D({ lastRunAt: at(14, 32, 5), lastResult: 'ok' });
  assert.equal(syncDiagText({ ...base, runningSince: now - 9000 }, { now }), '上次检查 14:32:05 · 连线正常');
  assert.equal(syncDiagText({ ...base, runningSince: now - 25000 }, { now }), '上次检查 14:32:05 · 连线正常 · 进行中 25 秒');
  assert.equal(syncDiagText(base, { now, realtime: 'live' }), '上次检查 14:32:05 · 连线正常 · 即时连线');
  assert.equal(syncDiagText(base, { now, realtime: 'connecting' }), '上次检查 14:32:05 · 连线正常 · 即时连线中');
  assert.equal(syncDiagText(base, { now, realtime: 'off' }), '上次检查 14:32:05 · 连线正常');
});

test('复审 S15：诊断行分段（每段整组换行；读屏用逗号停顿、不念「·」）', () => {
  const now = at(14, 33, 0);
  assert.deepEqual(syncDiagParts(D({ lastRunAt: at(14, 32, 5), lastResult: 'ok', lastAdopted: 1 }), { now, realtime: 'live' }),
    ['上次检查 14:32:05', '连线正常', '收到 1 笔', '即时连线']);
});

// ---------- 2f 整体审核后用户决定：登出时按「先同步」＝已同意认领，不再问 ----------
test('createClaimRunner：第二个参数（consented）原样交给 ensure', async () => {
  const got = [];
  const run = createClaimRunner({ ensure: (fromUser, opts) => { got.push([fromUser, opts]); return 'mine'; }, onMine: () => {}, onError: () => {} });
  await run(true, { consented: true });
  assert.deepEqual(got, [[true, { consented: true }]]);
});

test('app.js：consented 时认领提示直接当成「开始」；设置页 onStartSync 把参数传给 runClaim', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /ensure: \(fromUser, \{ consented = false \} = \{\}\) =>/);
  assert.match(app, /ask: consented \? async \(\) => 'start' :/);
  assert.match(app, /onStartSync: \(opts\) => runClaim\(true, opts\)/);
});
