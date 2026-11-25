// 2d：启动时先看有没有登录、设置页账号区、登出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootTarget, signOut, saveSession, savePending, saveLastUserId, loadSession, loadPending, loadLastUserId } from '../js/auth.js';
import { accountRows } from '../js/ui/settings.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

const NOW = Date.parse('2026-11-24T02:00:00Z');
const SESSION = { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3600e3, user_id: 'u-1', email: 'me@x.com', platform: 'pwa' };

test('bootTarget：没有 session → 登录页；有 → App；过期的 session 仍进 App（本地优先，2e 才刷新）', () => {
  assert.equal(bootTarget(null), 'login');
  assert.equal(bootTarget(SESSION), 'app');
  assert.equal(bootTarget({ ...SESSION, expires_at: NOW - 86400e3 }), 'app');
});

test('accountRows：有 session → 邮箱一列、登出一列；没有 → 空', () => {
  const rows = accountRows(SESSION);
  assert.deepEqual(rows.map((r) => r.kind), ['email', 'sync', 'signout']);
  assert.equal(rows[0].label, '邮箱');
  assert.equal(rows[0].detail, 'me@x.com');
  assert.equal(rows[1].label, '同步');
  assert.equal(rows[2].label, '登出');
  assert.deepEqual(accountRows(null), []);
});

test('signOut：session、pending、lastUserId 都清掉才 reload（2f：登出清本机账本，lastUserId 也不留）', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await saveSession(store, SESSION);
  await savePending(store, { email: 'me@x.com', sentAt: NOW });
  await saveLastUserId(store, 'u-1');
  const order = [];
  const ok = await signOut(store, () => order.push('reload'));
  assert.equal(ok, true);
  assert.deepEqual(order, ['reload']);
  assert.equal(await loadSession(store), null);
  assert.equal(await loadPending(store, NOW), null);
  assert.equal(await loadLastUserId(store), null);
  assert.equal(store.categories('expense').length, 6);
});

test('signOut：写入失败 → 回 false、不 reload', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  await saveSession(store, SESSION);
  db.failNextWrite(new Error('disk'));
  let reloaded = false;
  const ok = await signOut(store, () => { reloaded = true; });
  assert.equal(ok, false);
  assert.equal(reloaded, false);
});

test('app.js：开库后先读 session，决定登录页或 App；登录成功不重新载入页面', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /loadSession\(store\)/);
  assert.match(app, /bootTarget\(/);
  assert.match(app, /mountLogin\(/);
  assert.match(app, /mountShell\(root, store, s(ession)?\)/);
});
