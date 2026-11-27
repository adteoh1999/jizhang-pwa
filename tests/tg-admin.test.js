// 3b-5：tg-admin（只有站主：设定 bot 的选单按钮与简介）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, envOf } from './helpers/edge-fn.js';

// 全是假的测试资料
const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const BOT = '123456:' + 'D'.repeat(35);
const SECRET = 'W'.repeat(40);
const ENV_OBJ = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}`, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: SECRET };
const ENV = envOf(ENV_OBJ);
const UID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'owner@example.invalid';
const TOKEN = 'eyJ.owner-access-token.sig';

// 计划 Q4 的文字（用户已同意）
const MENU_TEXT = '记账';
const SHORT = '快速记账：点下方「记账」用邮箱登录（第一次需要邀请码）。';
const DESC = '点下方「记账」用邮箱登录并连接这个 Telegram，就能在这里记账、看统计，和记账 App 是同一本账（第一次需要邀请码）。连接后也可以直接传付款截图或打「午餐 12.50」，由 AI 自动识别记一笔。';

const req = (body, { origin = ORIGIN, method = 'POST', token = TOKEN } = {}) => new Request(`${BASE}/functions/v1/tg-admin`, {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

function routes({
  user = () => jsonRes(200, { id: UID, email: 'Owner@Example.invalid', app_metadata: { kind: 'email' } }),
  isOwner = () => jsonRes(200, true),
  tg = () => jsonRes(200, { ok: true, result: true }),
  aiCount = () => jsonRes(200, 12),
} = {}) {
  return fakeFetch([
    ['/auth/v1/user', user],
    ['/rpc/svc_is_owner', isOwner],
    ['/rpc/svc_bot_ai_count', aiCount],
    ['api.telegram.org', tg],
  ]);
}

async function quiet(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return { r: await fn(), logs }; } finally { Object.assign(console, orig); }
}

const tgCalls = (f) => f.callsTo('api.telegram.org');

for (const [label, mod] of await loadBoth('tg-admin')) {
  const run = async (body, f, { env = ENV, ...opts } = {}) => {
    const { r: res, logs } = await quiet(() => mod.handleTgAdmin(req(body, opts), { env, fetch: f }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 没有内容 */ }
    return { res, status: res.status, body: json, logs };
  };

  test(`${label}：OPTIONS → 204＋CORS；GET → 405`, async () => {
    const o = await run(null, routes(), { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal((await run(null, routes(), { method: 'GET' })).status, 405);
  });

  test(`${label}：没有 Bearer → 401，没叫任何服务器`, async () => {
    const f = routes();
    const r = await run({ action: 'setup' }, f, { token: null });
    assert.equal(r.status, 401);
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：body 坏掉、action 不是 setup／status／pause → 400，没叫任何服务器`, async () => {
    for (const b of ['x', {}, { action: 'nuke' }, ['setup']]) {
      const f = routes();
      const r = await run(b, f);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：缺设定、bot token 不合格 → 500，没叫任何服务器`, async () => {
    for (const over of [{ SUPABASE_URL: undefined }, { SUPABASE_SECRET_KEYS: undefined }, { TELEGRAM_BOT_TOKEN: undefined }, { TELEGRAM_BOT_TOKEN: ' ' }, { TELEGRAM_BOT_TOKEN: '1:x' },
      { TELEGRAM_WEBHOOK_SECRET: undefined }, { TELEGRAM_WEBHOOK_SECRET: 'short' }, { SUPABASE_URL: 'http://p.supabase.co' }]) {
      const f = routes();
      const r = await run({ action: 'setup' }, f, { env: envOf({ ...ENV_OBJ, ...over }) });
      assert.equal(r.status, 500, JSON.stringify(over));
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：token 无效 → 401；查身份失败 → 500；都没叫 Telegram`, async () => {
    for (const [user, want] of [[() => jsonRes(401, {}), 401], [() => jsonRes(403, { error_code: 'user_not_found' }), 401], [() => jsonRes(500, {}), 500]]) {
      const f = routes({ user });
      const r = await run({ action: 'setup' }, f);
      assert.equal(r.status, want);
      assert.equal(tgCalls(f).length, 0);
    }
  });

  test(`${label}：不是站主 → 403 没有权限，没叫 Telegram；不是邮箱账号连 svc_is_owner 都不问`, async () => {
    const a = routes({ isOwner: () => jsonRes(200, false) });
    const ra = await run({ action: 'setup' }, a);
    assert.equal(ra.status, 403);
    assert.deepEqual(ra.body, { error: '没有权限' });
    assert.equal(tgCalls(a).length, 0);
    assert.deepEqual(a.callsTo('/rpc/svc_is_owner')[0].body, { p_email: EMAIL });
    assert.equal(a.callsTo('/rpc/svc_is_owner')[0].init.headers.apikey, KEY);

    const b = routes({ user: () => jsonRes(200, { id: UID, email: EMAIL, app_metadata: { kind: 'anon' } }) });
    const rb = await run({ action: 'setup' }, b);
    assert.equal(rb.status, 403);
    assert.equal(b.callsTo('/rpc/svc_is_owner').length, 0);
    assert.equal(tgCalls(b).length, 0);
  });

  test(`${label}：svc_is_owner 出错或回传不是 true → 不当站主（出错 500、其他 403），没叫 Telegram`, async () => {
    const e = routes({ isOwner: () => jsonRes(500, {}) });
    assert.equal((await run({ action: 'setup' }, e)).status, 500);
    assert.equal(tgCalls(e).length, 0);
    const s = routes({ isOwner: () => jsonRes(200, 'true') });
    assert.equal((await run({ action: 'setup' }, s)).status, 403);
    assert.equal(tgCalls(s).length, 0);
  });

  test(`${label}：站主 setup → 依序 5 个 method（含 webhook 与指令），body 精确 → 200`, async () => {
    const f = routes();
    const r = await run({ action: 'setup' }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const c = tgCalls(f);
    // setWebhook 排第一（审核 S1：恢复功能优先，外观失败也不影响 webhook）
    assert.deepEqual(c.map((x) => x.url), ['setWebhook', 'setChatMenuButton', 'setMyShortDescription', 'setMyDescription', 'setMyCommands']
      .map((m) => `https://api.telegram.org/bot${BOT}/${m}`));
    // 用户决定 2：设定时丢掉积压讯息（暂停期间传的不会在恢复时补记）
    assert.deepEqual(c[0].body, { url: `${BASE}/functions/v1/telegram-bot`, secret_token: SECRET,
      allowed_updates: ['message', 'callback_query'], max_connections: 4, drop_pending_updates: true });
    assert.deepEqual(c[1].body, { menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: 'https://jizhang.adteoh.com/' } } });
    assert.deepEqual(c[2].body, { short_description: SHORT });
    assert.deepEqual(c[3].body, { description: DESC });
    assert.deepEqual(c[4].body, { commands: [{ command: 'start', description: '开始／说明' }, { command: 'help', description: '怎么记账' }] });
    assert.deepEqual(r.logs, []);
  });

  test(`${label}：用户 2026-11-27：setup 送给 Telegram 的文字（选单、简介、指令）都不出现 Claude／Anthropic`, async () => {
    const f = routes();
    await run({ action: 'setup' }, f);
    for (const c of tgCalls(f).slice(1)) assert.doesNotMatch(JSON.stringify(c.body), /claude|anthropic/i);
  });

  test(`${label}：status → getWebhookInfo＋AI 次数；不回 Telegram 的错误文字与网址`, async () => {
    const info = (o) => () => jsonRes(200, { ok: true, result: { url: `${BASE}/functions/v1/telegram-bot`, pending_update_count: 3,
      last_error_date: 1764000000, last_error_message: 'Wrong response ' + SECRET, ...o } });
    let f = routes({ tg: info() });
    let r = await run({ action: 'status' }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, webhook: 'ok', pending: 3, lastErrorAt: new Date(1764000000 * 1000).toISOString(), aiUsed24h: 12 });
    assert.deepEqual(tgCalls(f).map((x) => x.url), [`https://api.telegram.org/bot${BOT}/getWebhookInfo`]);
    assert.ok(!JSON.stringify(r.body).includes('Wrong response'));
    f = routes({ tg: info({ url: 'https://evil.example/hook', last_error_date: undefined }) });
    r = await run({ action: 'status' }, f);
    assert.equal(r.body.webhook, 'wrong_url');
    assert.equal(r.body.lastErrorAt, null);
    assert.ok(!JSON.stringify(r.body).includes('evil'));
    f = routes({ tg: info({ url: '' }), aiCount: () => jsonRes(500, {}) });
    r = await run({ action: 'status' }, f);
    assert.equal(r.body.webhook, 'none');
    assert.equal(r.body.aiUsed24h, null);
  });

  test(`${label}：status：Telegram 连不上 → 502`, async () => {
    const r = await run({ action: 'status' }, routes({ tg: () => jsonRes(500, { ok: false }) }));
    assert.equal(r.status, 502);
  });

  test(`${label}：pause → deleteWebhook（丢掉积压讯息）→ 200`, async () => {
    const f = routes();
    const r = await run({ action: 'pause' }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(tgCalls(f).map((x) => [x.url, x.body]), [[`https://api.telegram.org/bot${BOT}/deleteWebhook`, { drop_pending_updates: true }]]);
  });

  test(`${label}：status、pause 也只有站主`, async () => {
    for (const action of ['status', 'pause']) {
      const f = routes({ isOwner: () => jsonRes(200, false) });
      assert.equal((await run({ action }, f)).status, 403);
      assert.equal(tgCalls(f).length, 0);
    }
  });

  // 这里量的是测试档的常数；它和函数送出去的文字相同，由上一条「body 精确比对」保证
  test(`${label}：文字长度在 Telegram 上限内（简短介绍 ≤ 120、完整介绍 ≤ 512）`, () => {
    assert.ok([...SHORT].length <= 120 && SHORT.length <= 120);
    assert.ok([...DESC].length <= 512 && DESC.length <= 512);
  });

  test(`${label}：第 2 个失败 → 502，第 3 个没叫；日志只有 method 名＋状态码，不含 token`, async () => {
    let n = 0;
    const f = routes({ tg: () => (++n === 2 ? jsonRes(400, { ok: false, description: 'Bad Request ' + BOT }) : jsonRes(200, { ok: true, result: true })) });
    const r = await run({ action: 'setup' }, f);
    assert.equal(r.status, 502);
    assert.deepEqual(r.body, { error: 'Telegram 暂时连不上，请稍后再试' });
    assert.equal(tgCalls(f).length, 2);
    const all = r.logs.join('\n');
    assert.match(all, /setChatMenuButton/);
    assert.match(all, /400/);
    assert.ok(!all.includes(BOT) && !all.includes('DDDD') && !all.includes('Bad Request'));
    assert.ok(!all.includes(EMAIL) && !all.includes(TOKEN));
  });

  test(`${label}：第 1 个连线错、回 ok:false → 502，后面都没叫`, async () => {
    for (const tg of [() => { throw new TypeError('net ' + BOT); }, () => jsonRes(200, { ok: false })]) {
      const f = routes({ tg });
      const r = await run({ action: 'setup' }, f);
      assert.equal(r.status, 502);
      assert.equal(tgCalls(f).length, 1);
      assert.ok(!r.logs.join('\n').includes(BOT));
    }
  });
}

// 3b 审核 M1、S3：超时预算（3d 起前端等 20 秒、服务器 18 秒）、最外层保护
async function withTimeouts(fn) {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

for (const [label, mod] of await loadBoth('tg-admin')) {
  // 实测（2026-11-26）：第一次连 api.telegram.org 超过 1.5 秒（Telegram 其实已设好）→ 每步最多 5 秒；3d 起总时限 18 秒
  test(`${label}：超时：查身份 2000、svc_is_owner 2000、Bot API 每步最多 5000（时间充裕时）`, async () => {
    const f = routes();
    const clock = { t: 1_000_000 };
    const seen = await withTimeouts(() => quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env: ENV, fetch: f, nowMs: () => clock.t })));
    assert.equal(seen.length, f.calls.length);
    assert.deepEqual(seen, [2000, 2000, 5000, 5000, 5000, 5000, 5000]);
    // status：身份、站主、getWebhookInfo、AI 次数
    const g = routes({ tg: () => jsonRes(200, { ok: true, result: { url: '', pending_update_count: 0 } }) });
    const seen2 = await withTimeouts(() => quiet(() => mod.handleTgAdmin(req({ action: 'status' }), { env: ENV, fetch: g, nowMs: () => clock.t })));
    assert.deepEqual(seen2, [2000, 2000, 5000, 2000]);
  });

  test(`${label}：总时限 18 秒：前面用掉的时间会让后面每一步缩短；时间用完就不再叫 Telegram、回 502`, async () => {
    const clock = { t: 1_000_000 };
    let n = 0;
    const f = routes({ tg: () => { n += 1; clock.t += 4000; return jsonRes(200, { ok: true, result: true }); } });
    const seen = await withTimeouts(() => quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env: ENV, fetch: f, nowMs: () => clock.t })));
    // 剩 18000、14000、10000、6000 → 5000；剩 2000 → 2000
    assert.deepEqual(seen, [2000, 2000, 5000, 5000, 5000, 5000, 2000]);
    // 审核 S2：剩不到 1 秒就当时间用完、不送（送了必然逾时）
    const clock3 = { t: 1_000_000 };
    const h = routes({ tg: () => { clock3.t += 4300; return jsonRes(200, { ok: true, result: true }); } });
    const { r: res3 } = await quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env: ENV, fetch: h, nowMs: () => clock3.t }));
    assert.equal(res3.status, 502);
    assert.equal(tgCalls(h).length, 4);
    const clock2 = { t: 1_000_000 };
    const g = routes({ tg: () => { clock2.t += 19000; return jsonRes(200, { ok: true, result: true }); } });
    const { r: res, logs } = await quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env: ENV, fetch: g, nowMs: () => clock2.t }));
    assert.equal(res.status, 502);
    assert.equal(tgCalls(g).length, 1, '时间用完就不再叫');
    assert.equal(seen.length > 0, true);
    assert.ok(!logs.join('\n').includes(BOT));
  });

  test(`${label}：意外的错误 → 500 固定句子，带 CORS，日志不含错误原文`, async () => {
    const env = (k) => { if (k === 'TELEGRAM_BOT_TOKEN') throw new Error('LEAK ' + BOT); return ENV(k); };
    const { r: res, logs } = await quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env, fetch: routes() }));
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '暂时无法完成，请稍后再试' });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.ok(!logs.join('\n').includes('LEAK'));
  });
}


// ======================= 审核（Task 9）补测 =======================
for (const [label, mod] of await loadBoth('tg-admin')) {
  const run = async (body, f, env = ENV) => {
    const { r: res, logs } = await quiet(() => mod.handleTgAdmin(req(body), { env, fetch: f }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 没有内容 */ }
    return { status: res.status, body: json, logs, text };
  };

  test(`${label}：审核 M2：webhook 密钥坏了 → setup 500 零呼叫；pause、status 照样能用`, async () => {
    const bad = envOf({ ...ENV_OBJ, TELEGRAM_WEBHOOK_SECRET: 'short' });
    let f = routes();
    assert.equal((await run({ action: 'setup' }, f, bad)).status, 500);
    assert.equal(f.calls.length, 0);
    f = routes();
    assert.equal((await run({ action: 'pause' }, f, bad)).status, 200);
    assert.equal(tgCalls(f)[0].url, `https://api.telegram.org/bot${BOT}/deleteWebhook`);
    f = routes({ tg: () => jsonRes(200, { ok: true, result: { url: '', pending_update_count: 0 } }) });
    assert.equal((await run({ action: 'status' }, f, bad)).status, 200);
  });

  test(`${label}：审核 S5：SUPABASE_URL 带尾斜线 → webhook 网址没有双斜线`, async () => {
    const f = routes();
    await run({ action: 'setup' }, f, envOf({ ...ENV_OBJ, SUPABASE_URL: BASE + '/' }));
    assert.equal(tgCalls(f)[0].body.url, `${BASE}/functions/v1/telegram-bot`);
  });

  test(`${label}：审核 T1：setWebhook 失败、Telegram 的说明带着密钥 → 日志与回应都没有密钥`, async () => {
    const f = routes({ tg: () => jsonRes(400, { ok: false, description: 'bad secret ' + SECRET }) });
    const r = await run({ action: 'setup' }, f);
    assert.equal(r.status, 502);
    assert.ok(!r.logs.join('\n').includes(SECRET) && !r.text.includes(SECRET));
    assert.ok(!r.logs.join('\n').includes('functions/v1'));
  });

  test(`${label}：审核 T2／S3：status 资料怪 → 安全的值；成功时日志是空的`, async () => {
    const cases = [
      [{ url: `${BASE}/functions/v1/telegram-bot`, pending_update_count: -3, last_error_date: 1e15 }, { webhook: 'ok', pending: 0, lastErrorAt: null }],
      [{ url: `${BASE}/functions/v1/telegram-bot/`, pending_update_count: 1.5, last_error_date: '1764000000' }, { webhook: 'wrong_url', pending: 0, lastErrorAt: null }],
      [{ url: `${BASE.toUpperCase()}/functions/v1/telegram-bot`, pending_update_count: '2', last_error_date: -1 }, { webhook: 'wrong_url', pending: 0, lastErrorAt: null }],
    ];
    for (const [result, want] of cases) {
      const f = routes({ tg: () => jsonRes(200, { ok: true, result }) });
      const r = await run({ action: 'status' }, f);
      assert.equal(r.status, 200);
      assert.deepEqual({ webhook: r.body.webhook, pending: r.body.pending, lastErrorAt: r.body.lastErrorAt }, want, JSON.stringify(result));
      assert.deepEqual(r.logs, []);
    }
    for (const n of ['12', 1.5, -1]) {
      const f = routes({ tg: () => jsonRes(200, { ok: true, result: 'x' }), aiCount: () => jsonRes(200, n) });
      const r = await run({ action: 'status' }, f);
      assert.equal(r.body.aiUsed24h, null, String(n));
      assert.equal(r.body.webhook, 'none');
    }
  });

  test(`${label}：审核 T3：pause 失败 → 502，日志只有 deleteWebhook＋状态码`, async () => {
    const r = await run({ action: 'pause' }, routes({ tg: () => jsonRes(400, { ok: false, description: 'x ' + BOT }) }));
    assert.equal(r.status, 502);
    assert.match(r.logs.join('\n'), /deleteWebhook: HTTP 400/);
    assert.ok(!r.logs.join('\n').includes(BOT));
  });
}
