// 3b-10：设置页的 Telegram 列（纯函数）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountRows, adminRows, envText, tgRowDetail, tgStatusText } from '../js/ui/settings.js';

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
  assert.deepEqual(adminRows(true).map((r) => r.kind), ['invites', 'tg-setup', 'tg-status', 'tg-pause']);
  assert.equal(adminRows(true)[1].label, '设定 Telegram bot');
  assert.deepEqual(adminRows(false), []);
});

test('envText：PWA／浏览器／Telegram · 平台 · 版本', () => {
  assert.equal(envText({ telegram: null, standalone: true }), 'PWA');
  assert.equal(envText({ telegram: null, standalone: false }), '浏览器');
  assert.equal(envText({ telegram: { platform: 'ios', version: '8.0' }, standalone: false }), 'Telegram · ios · 8.0');
  assert.equal(envText({ telegram: { platform: '', version: '' } }), 'Telegram');
});

// 3d：「检查 Telegram bot」对话框的文字（纯函数）
test('tgStatusText：正常、待处理、最近错误（马来西亚时间）、AI 次数', () => {
  assert.deepEqual(tgStatusText({ webhook: 'ok', pending: 0, lastErrorAt: null, aiUsed24h: 5 }), {
    title: '正常', message: '待处理讯息：0 则\n最近错误：没有\n24 小时内 AI 用了：5 次' });
  assert.deepEqual(tgStatusText({ webhook: 'none', pending: 3, lastErrorAt: '2026-11-26T02:05:00.000Z', aiUsed24h: null }), {
    title: '没设好，请按「设定 Telegram bot」', message: '待处理讯息：3 则\n最近错误：2026-11-26 10:05\n24 小时内 AI 用了：—' });
  assert.equal(tgStatusText({ webhook: 'wrong_url', pending: 0, lastErrorAt: null, aiUsed24h: 0 }).title, '没设好，请按「设定 Telegram bot」');
});

// 3d 接线（审核 M3：行为测试在 tg-admin-actions.test.js；这里只确认设置页用了那个模块）
import { readFileSync } from 'node:fs';
test('接线：设置页用 createTgAdminActions，三个 API 都传进去', () => {
  const src = readFileSync(new URL('../js/ui/settings.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bcreateTgAdminActions\b[^}]*\} from '\.\/tg-admin-actions\.js'/);
  assert.match(src, /import \{[^}]*\btgAdminSetup\b[^}]*\btgAdminStatus\b[^}]*\btgAdminPause\b[^}]*\} from '\.\.\/tg-api\.js'/);
  assert.match(src, /createTgAdminActions\(\{/);
});
