// 3d Task 9 审核 M3：设置页「设定／检查／暂停 Telegram bot」三个按钮的流程（可注入，测行为）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTgAdminActions, tgStatusText, TG_ADMIN_TEXT } from '../js/ui/tg-admin-actions.js';

function setup({ session = { access_token: 'tok' }, confirm = true, api = {}, getSession } = {}) {
  const log = [];
  const deps = {
    getSession: getSession ?? (async () => ({ session })),
    api: {
      setup: api.setup ?? (async (t) => { log.push(['api', 'setup', t]); return { ok: true }; }),
      status: api.status ?? (async (t) => { log.push(['api', 'status', t]); return { ok: true, data: { webhook: 'ok', pending: 0, lastErrorAt: null, aiUsed24h: 1 } }; }),
      pause: api.pause ?? (async (t) => { log.push(['api', 'pause', t]); return { ok: true }; }),
    },
    confirm: async (o) => { log.push(['confirm', o]); return confirm; },
    message: async (o) => { log.push(['message', o]); },
    toast: (t) => log.push(['toast', t]),
    onBusy: (kind, busy) => log.push(['busy', kind, busy]),
  };
  return { actions: createTgAdminActions(deps), log };
}
const apiCalls = (log) => log.filter((x) => x[0] === 'api');

test('设定：成功 → toast；忙碌开、关各一次', async () => {
  const { actions, log } = setup();
  assert.equal(await actions.click('tg-setup'), 'done');
  assert.deepEqual(log, [['busy', 'tg-setup', true], ['api', 'setup', 'tok'], ['busy', 'tg-setup', false], ['toast', '已设定 Telegram bot']]);
});

test('暂停：按取消 → 没叫 tgAdminPause、没进忙碌', async () => {
  const { actions, log } = setup({ confirm: false });
  assert.equal(await actions.click('tg-pause'), 'cancel');
  assert.equal(apiCalls(log).length, 0);
  assert.equal(log.filter((x) => x[0] === 'busy').length, 0);
  assert.equal(log[0][0], 'confirm');
  assert.equal(log[0][1].message, TG_ADMIN_TEXT.pauseMessage);
  assert.equal(log[0][1].destructive, true);
});

test('暂停：确认 → 叫 pause → toast', async () => {
  const { actions, log } = setup();
  assert.equal(await actions.click('tg-pause'), 'done');
  assert.deepEqual(apiCalls(log), [['api', 'pause', 'tok']]);
  assert.deepEqual(log[log.length - 1], ['toast', '已暂停 Telegram bot']);
});

test('进行中再按（另一个按钮、或暂停的确认框开着）→ 不叫第二次', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const { actions, log } = setup({ api: { setup: async () => { await slow; return { ok: true }; } } });
  const first = actions.click('tg-setup');
  assert.equal(await actions.click('tg-status'), 'busy');
  assert.equal(await actions.click('tg-pause'), 'busy');
  release();
  assert.equal(await first, 'done');
  assert.equal(log.filter((x) => x[0] === 'confirm').length, 0);
});

test('成功与失败都会解除忙碌', async () => {
  const { actions, log } = setup({ api: { status: async () => ({ ok: false, error: '没有权限' }) } });
  assert.equal(await actions.click('tg-status'), 'fail');
  assert.deepEqual(log.filter((x) => x[0] === 'busy'), [['busy', 'tg-status', true], ['busy', 'tg-status', false]]);
  assert.deepEqual(log[log.length - 1], ['message', { title: '没能检查 Telegram bot', message: '没有权限' }]);
});

test('没有 session → 请重新登录；丢例外 → 通用句；都解除忙碌', async () => {
  let { actions, log } = setup({ session: null });
  assert.equal(await actions.click('tg-setup'), 'fail');
  assert.deepEqual(log[log.length - 1], ['message', { title: '没能设定 Telegram bot', message: '请重新登录后再试' }]);
  ({ actions, log } = setup({ getSession: async () => { throw new Error('boom'); } }));
  assert.equal(await actions.click('tg-pause'), 'fail');
  assert.deepEqual(log[log.length - 1], ['message', { title: '没能暂停 Telegram bot', message: '暂时无法完成，请稍后再试' }]);
  assert.deepEqual(log.filter((x) => x[0] === 'busy').map((x) => x[2]), [true, false]);
  // 例外之后可以再按
  assert.equal(log.length > 0, true);
});

test('检查：成功 → 对话框内容就是 tgStatusText 的结果', async () => {
  const data = { webhook: 'none', pending: 2, lastErrorAt: null, aiUsed24h: 3 };
  const { actions, log } = setup({ api: { status: async () => ({ ok: true, data }) } });
  await actions.click('tg-status');
  assert.deepEqual(log[log.length - 1], ['message', tgStatusText(data)]);
});

test('tgStatusText：跨日时间（UTC 17:30 → 马来西亚隔天 01:30）', () => {
  assert.equal(tgStatusText({ webhook: 'ok', pending: 0, lastErrorAt: '2026-11-26T17:30:00.000Z', aiUsed24h: 0 }).message,
    '待处理讯息：0 则\n最近错误：2026-11-27 01:30\n24 小时内 AI 用了：0 次');
});

test('不认得的按钮 → 不做事', async () => {
  const { actions, log } = setup();
  assert.equal(await actions.click('nuke'), 'cancel');
  assert.deepEqual(log, []);
});

// 用户决定 9：webhook 设好了、但 10 分钟内有错误 → 标题提醒
test('tgStatusText：10 分钟内有错误 → 「已设定，但最近有错误」；超过 10 分钟 → 正常；没设好照旧', () => {
  const now = Date.parse('2026-11-27T08:00:00.000Z');
  const d = (lastErrorAt, webhook = 'ok') => ({ webhook, pending: 0, lastErrorAt, aiUsed24h: 0 });
  assert.equal(tgStatusText(d('2026-11-27T07:51:00.000Z'), now).title, '已设定，但最近有错误');
  assert.equal(tgStatusText(d('2026-11-27T07:50:00.000Z'), now).title, '已设定，但最近有错误');
  assert.equal(tgStatusText(d('2026-11-27T07:49:59.000Z'), now).title, '正常');
  assert.equal(tgStatusText(d(null), now).title, '正常');
  assert.equal(tgStatusText(d('2026-11-27T07:59:00.000Z', 'wrong_url'), now).title, '没设好，请按「设定 Telegram bot」');
});
test('检查：对话框标题用当下时间判断（最近错误 → 提醒）', async () => {
  const data = { webhook: 'ok', pending: 0, lastErrorAt: new Date(Date.now() - 60000).toISOString(), aiUsed24h: 0 };
  const { actions, log } = setup({ api: { status: async () => ({ ok: true, data }) } });
  await actions.click('tg-status');
  assert.equal(log[log.length - 1][1].title, '已设定，但最近有错误');
});
