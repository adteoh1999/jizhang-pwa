// 3b-5：tg-admin（只有站主：设定 bot 的选单按钮与简介）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, envOf } from './helpers/edge-fn.js';

// 全是假的测试资料
const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const BOT = '123456:' + 'D'.repeat(35);
const ENV_OBJ = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}`, TELEGRAM_BOT_TOKEN: BOT };
const ENV = envOf(ENV_OBJ);
const UID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'owner@example.invalid';
const TOKEN = 'eyJ.owner-access-token.sig';

// 计划 Q4 的文字（用户已同意）
const MENU_TEXT = '记账';
const SHORT = '快速记账：点下方「记账」用邮箱登录（第一次需要邀请码）。';
const DESC = '点下方「记账」按钮，用邮箱验证码登录并连接这个 Telegram，就能在这里记账、看统计，和手机上的记账 App 是同一本账。第一次使用需要邀请码。';

const req = (body, { origin = ORIGIN, method = 'POST', token = TOKEN } = {}) => new Request(`${BASE}/functions/v1/tg-admin`, {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

function routes({
  user = () => jsonRes(200, { id: UID, email: 'Owner@Example.invalid', app_metadata: { kind: 'email' } }),
  isOwner = () => jsonRes(200, true),
  tg = () => jsonRes(200, { ok: true, result: true }),
} = {}) {
  return fakeFetch([
    ['/auth/v1/user', user],
    ['/rpc/svc_is_owner', isOwner],
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

  test(`${label}：body 坏掉、action 不是 setup → 400，没叫任何服务器`, async () => {
    for (const b of ['x', {}, { action: 'nuke' }, ['setup']]) {
      const f = routes();
      const r = await run(b, f);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：缺设定、bot token 不合格 → 500，没叫任何服务器`, async () => {
    for (const over of [{ SUPABASE_URL: undefined }, { SUPABASE_SECRET_KEYS: undefined }, { TELEGRAM_BOT_TOKEN: undefined }, { TELEGRAM_BOT_TOKEN: ' ' }, { TELEGRAM_BOT_TOKEN: '1:x' }]) {
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

  test(`${label}：站主 → 依序 setChatMenuButton、setMyShortDescription、setMyDescription，body 精确 → 200`, async () => {
    const f = routes();
    const r = await run({ action: 'setup' }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const c = tgCalls(f);
    assert.deepEqual(c.map((x) => x.url), ['setChatMenuButton', 'setMyShortDescription', 'setMyDescription'].map((m) => `https://api.telegram.org/bot${BOT}/${m}`));
    assert.deepEqual(c[0].body, { menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: 'https://jizhang.adteoh.com/' } } });
    assert.deepEqual(c[1].body, { short_description: SHORT });
    assert.deepEqual(c[2].body, { description: DESC });
    assert.deepEqual(r.logs, []);
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
    assert.match(all, /setMyShortDescription/);
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

// 3b 审核 M1、S3：超时预算（前端等 10 秒）、最外层保护
async function withTimeouts(fn) {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

for (const [label, mod] of await loadBoth('tg-admin')) {
  test(`${label}：超时：查身份 2000、svc_is_owner 2000、每个 Bot API 1500（合计 8.5 秒 < 前端 10 秒）`, async () => {
    const f = routes();
    const seen = await withTimeouts(() => quiet(() => mod.handleTgAdmin(req({ action: 'setup' }), { env: ENV, fetch: f })));
    assert.equal(seen.length, f.calls.length);
    assert.deepEqual(seen, [2000, 2000, 1500, 1500, 1500]);
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
