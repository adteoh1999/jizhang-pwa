// 3b-10：设置页的 Telegram 列（纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountRows, adminRows, envText, tgRowDetail } from '../js/ui/settings.js';

const S = { user_id: 'u-A', email: 'me@x.invalid' };
const kinds = (rows) => rows.map((r) => r.kind);

test('accountRows PWA：没有 tg 资料 → 邮箱、同步、登出（不显示 Telegram 列）', () => {
  assert.deepEqual(kinds(accountRows(S)), ['email', 'sync', 'signout']);
  assert.deepEqual(kinds(accountRows(S, { platform: 'pwa', tg: null })), ['email', 'sync', 'signout']);
});

test('accountRows PWA：已连接 → 邮箱、Telegram、同步、解除 Telegram 连接（红）、登出；没连接 → 没有解除列', () => {
  const on = accountRows(S, { platform: 'pwa', tg: { linked: true, label: '@zed' } });
  assert.deepEqual(kinds(on), ['email', 'tg', 'sync', 'tg-unlink', 'signout']);
  assert.equal(on[1].detail, '@zed');
  assert.equal(on[3].label, '解除 Telegram 连接');
  const off = accountRows(S, { platform: 'pwa', tg: { linked: false, label: '' } });
  assert.deepEqual(kinds(off), ['email', 'tg', 'sync', 'signout']);
  assert.equal(off[1].detail, '未连接');
});

test('accountRows Telegram：邮箱、Telegram、同步、解除连接（红）；没有登出；tg 还没读到先显示「已连接」', () => {
  const rows = accountRows(S, { platform: 'telegram', tg: null });
  assert.deepEqual(kinds(rows), ['email', 'tg', 'sync', 'tg-unlink']);
  assert.equal(rows[1].detail, '已连接');
  assert.equal(rows[3].label, '解除连接');
  assert.ok(!kinds(accountRows(S, { platform: 'telegram', tg: { linked: true, label: '@zed' } })).includes('signout'));
  assert.deepEqual(accountRows(null, { platform: 'telegram' }), []);
});

test('tgRowDetail：有名字显示名字；名字空 → 「已连接」；没连接 → 「未连接」', () => {
  assert.equal(tgRowDetail({ linked: true, label: '<b>x</b>' }), '<b>x</b>');
  assert.equal(tgRowDetail({ linked: true, label: '' }), '已连接');
  assert.equal(tgRowDetail({ linked: false, label: 'old' }), '未连接');
  assert.equal(tgRowDetail(null), '已连接');
});

test('adminRows：站主多「设定 Telegram bot」', () => {
  assert.deepEqual(adminRows(true).map((r) => r.kind), ['invites', 'tg-setup']);
  assert.equal(adminRows(true)[1].label, '设定 Telegram bot');
  assert.deepEqual(adminRows(false), []);
});

test('envText：PWA／浏览器／Telegram · 平台 · 版本', () => {
  assert.equal(envText({ telegram: null, standalone: true }), 'PWA');
  assert.equal(envText({ telegram: null, standalone: false }), '浏览器');
  assert.equal(envText({ telegram: { platform: 'ios', version: '8.0' }, standalone: false }), 'Telegram · ios · 8.0');
  assert.equal(envText({ telegram: { platform: '', version: '' } }), 'Telegram');
});
