// 3b-3：tg-login（公开，只凭 initData：已连接就换 session）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, hang, envOf } from './helpers/edge-fn.js';
import { signInitData } from './helpers/tg-init-data.js';
import { tgLabel } from '../supabase/functions/_shared/telegram.ts';

// 全是假的测试资料
const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const BOT = '123456:' + 'B'.repeat(35);
const ENV_OBJ = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}`, TELEGRAM_BOT_TOKEN: BOT };
const ENV = envOf(ENV_OBJ);
const NOW = 1764000100;
const TID = 987654321;
const TG_USER = { id: TID, first_name: 'Zed', last_name: 'Quokka', username: 'zedquokka' };
const LABEL = tgLabel(TG_USER);
const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'tgme@example.invalid';
const AT = 'eyJ.minted-access.sig';
const RT = 'minted-refresh-token';
const TG_BIND_MAX_SEC = 600;

const initDataAt = (authDate, user = TG_USER) => signInitData({
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: JSON.stringify(user), auth_date: String(authDate),
}, BOT);
const FRESH = initDataAt(NOW - 100);

const req = (body, { origin = ORIGIN, method = 'POST' } = {}) => new Request(`${BASE}/functions/v1/tg-login`, {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

// linkGets：svc_tg_link_get 依序回传的东西（第 1 次、第 2 次…），最后一个重复使用
function routes({
  touch = () => jsonRes(200, UID),
  linkGets = [() => jsonRes(200, UID)],
  admin = () => jsonRes(200, { id: UID, email: 'TgMe@Example.invalid', app_metadata: { kind: 'email' } }),
  gl = () => jsonRes(200, { id: UID, email: EMAIL, verification_type: 'magiclink', hashed_token: 'HASHED', action_link: 'https://x/verify?token=SECRET', email_otp: '123456' }),
  verify = () => jsonRes(200, { access_token: AT, refresh_token: RT, expires_in: 3600, token_type: 'bearer', user: { id: UID, email: EMAIL } }),
  logout = () => new Response(null, { status: 204 }),
} = {}) {
  let n = 0;
  return fakeFetch([
    ['/rpc/svc_tg_touch', touch],
    ['/rpc/svc_tg_link_get', (...a) => linkGets[Math.min(n++, linkGets.length - 1)](...a)],
    ['/auth/v1/admin/generate_link', gl],
    ['/auth/v1/admin/users/', admin],
    ['/auth/v1/verify', verify],
    ['/auth/v1/logout', logout],
  ]);
}

// 收集 console 输出
async function quiet(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return { r: await fn(), logs }; } finally { Object.assign(console, orig); }
}

// 记下每次 AbortSignal.timeout 的毫秒数
async function withTimeouts(fn) {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

const SECRETS = [FRESH, String(TID), AT, RT, EMAIL, 'tgme@', 'zedquokka', 'Quokka', 'HASHED', 'SECRET', KEY, BOT, UID];
function assertCleanLogs(logs, what) {
  const all = logs.join('\n');
  for (const s of SECRETS) assert.ok(!all.includes(s), `${what}：日志不能含 ${s.slice(0, 12)}…`);
}

for (const [label, mod] of await loadBoth('tg-login')) {
  const run = async (body, f, { env = ENV, now = NOW, ...opts } = {}) => {
    const { r: res, logs } = await quiet(() => mod.handleTgLogin(req(body, opts), { env, fetch: f, nowSec: () => now }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 没有内容 */ }
    return { res, status: res.status, body: json, text, logs };
  };

  // ---------- 方法、body、CORS ----------

  test(`${label}：OPTIONS → 204，带 CORS；GET → 405`, async () => {
    const o = await run(null, routes(), { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const g = await run(null, routes(), { method: 'GET' });
    assert.equal(g.status, 405);
  });

  test(`${label}：不在名单的来源 → 没有 allow-origin，但一样有 Vary: Origin`, async () => {
    const r = await run({ initData: FRESH }, routes(), { origin: 'https://evil.example' });
    assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), null);
    assert.match(r.res.headers.get('Vary') ?? '', /Origin/);
  });

  test(`${label}：body 不是 JSON、没有 initData、initData 不是字串 → 400，没叫任何服务器`, async () => {
    for (const b of ['not json', {}, { initData: 123 }, { initData: null }, [FRESH]]) {
      const f = routes();
      const r = await run(b, f);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.deepEqual(r.body, { error: '看不懂这个请求' });
      assert.equal(f.calls.length, 0);
    }
  });

  // ---------- 设定 ----------

  test(`${label}：bot token 缺、空白、太短 → 500，且没验签（坏 initData 也回 500 不是 401）、没叫任何服务器`, async () => {
    for (const t of [undefined, '', '   ', '123:abc']) {
      const f = routes();
      const r = await run({ initData: 'garbage' }, f, { env: envOf({ ...ENV_OBJ, TELEGRAM_BOT_TOKEN: t }) });
      assert.equal(r.status, 500, String(t));
      assert.deepEqual(r.body, { error: '暂时无法登录，请稍后再试' });
      assert.equal(f.calls.length, 0);
      assertCleanLogs(r.logs, 'bot token');
    }
  });

  test(`${label}：缺 SUPABASE_URL 或 secret key → 500，没叫任何服务器`, async () => {
    for (const env of [envOf({ ...ENV_OBJ, SUPABASE_URL: undefined }), envOf({ ...ENV_OBJ, SUPABASE_SECRET_KEYS: undefined })]) {
      const f = routes();
      const r = await run({ initData: FRESH }, f, { env });
      assert.equal(r.status, 500);
      assert.equal(f.calls.length, 0);
    }
  });

  // ---------- 验签 ----------

  test(`${label}：坏 hash → 401，没叫任何服务器；日志只有原因种类`, async () => {
    const bad = FRESH.replace(/hash=[0-9a-f]{4}/, 'hash=0000');
    const f = routes();
    const r = await run({ initData: bad }, f);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: '无法确认 Telegram 身份' });
    assert.equal(f.calls.length, 0);
    assert.match(r.logs.join('\n'), /hash/);
    assertCleanLogs(r.logs, '坏 hash');
  });

  test(`${label}：86401 秒前 → 401；auth_date 比服务器快 61 秒 → 401；都没叫服务器`, async () => {
    for (const t of [NOW - 86401, NOW + 61]) {
      const f = routes();
      const r = await run({ initData: initDataAt(t) }, f);
      assert.equal(r.status, 401, String(t));
      assert.equal(f.calls.length, 0);
      assertCleanLogs(r.logs, String(t));
    }
  });

  // ---------- 没连接 ----------

  test(`${label}：新鲜但没连接 → 200 unlinked＋label＋bindLeft；没叫 admin、generate_link`, async () => {
    const f = routes({ touch: () => jsonRes(200, null) });
    const r = await run({ initData: FRESH }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'unlinked', label: LABEL, bindLeft: TG_BIND_MAX_SEC - 100 });
    assert.equal(f.callsTo('/auth/v1/').length, 0);
    assert.equal(f.callsTo('/rpc/svc_tg_link_get').length, 0);
  });

  test(`${label}：bindLeft = auth_date + 600 − 服务器现在；已经超过 → 0（不回负数）`, async () => {
    for (const [age, want] of [[0, 600], [299, 301], [599, 1], [600, 0], [5000, 0]]) {
      const f = routes({ touch: () => jsonRes(200, null), linkGets: [() => jsonRes(200, null)] });
      const r = await run({ initData: initDataAt(NOW - age) }, f);
      assert.equal(r.body.status, 'unlinked', String(age));
      assert.equal(r.body.bindLeft, want, String(age));
    }
  });

  test(`${label}：svc_tg_touch 送的是 telegram_id（数字）和验签后的名字；用 secret key、svc schema`, async () => {
    const f = routes({ touch: () => jsonRes(200, null) });
    await run({ initData: FRESH, label: '假名字' }, f);
    const c = f.callsTo('/rpc/svc_tg_touch')[0];
    assert.equal(c.url, `${BASE}/rest/v1/rpc/svc_tg_touch`);
    assert.deepEqual(c.body, { p_telegram_id: TID, p_label: LABEL });
    assert.equal(c.init.headers.apikey, KEY);
    assert.equal(c.init.headers['Content-Profile'], 'svc');
  });

  // ---------- 不新鲜（301 秒～86400 秒） ----------

  test(`${label}：301 秒前、有连接 → 200 stale；只读 link_get，没叫 touch、admin、generate_link`, async () => {
    const f = routes();
    const r = await run({ initData: initDataAt(NOW - 301) }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'stale' });
    assert.equal(f.callsTo('/rpc/svc_tg_touch').length, 0);
    assert.deepEqual(f.callsTo('/rpc/svc_tg_link_get')[0].body, { p_telegram_id: TID });
    assert.equal(f.callsTo('/auth/v1/').length, 0);
  });

  test(`${label}：86400 秒前、没连接 → 200 unlinked（bindLeft 0）；没叫 touch`, async () => {
    const f = routes({ linkGets: [() => jsonRes(200, null)] });
    const r = await run({ initData: initDataAt(NOW - 86400) }, f);
    assert.deepEqual(r.body, { status: 'unlinked', label: LABEL, bindLeft: 0 });
    assert.equal(f.callsTo('/rpc/svc_tg_touch').length, 0);
  });

  // ---------- 已连接 ----------

  test(`${label}：新鲜、已连接 → 200 linked，栏位精确、no-store`, async () => {
    const f = routes();
    const r = await run({ initData: FRESH }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      status: 'linked', access_token: AT, refresh_token: RT, expires_in: 3600, user: { id: UID, email: EMAIL }, label: LABEL,
    });
    assert.equal(r.res.headers.get('Cache-Control'), 'no-store');
    assert.equal(f.callsTo('/auth/v1/logout').length, 0);
    assertCleanLogs(r.logs, 'linked');
  });

  test(`${label}：已连接的流程：touch → admin 查人 → generate_link → verify → 再查一次 link_get`, async () => {
    const f = routes();
    await run({ initData: FRESH }, f);
    const seq = f.calls.map((c) => c.url.replace(BASE, '').replace(/\?.*$/, '').replace(UID, '<uid>'));
    assert.deepEqual(seq, [
      '/rest/v1/rpc/svc_tg_touch', '/auth/v1/admin/users/<uid>', '/auth/v1/admin/generate_link', '/auth/v1/verify', '/rest/v1/rpc/svc_tg_link_get',
    ]);
    assert.deepEqual(f.callsTo('/auth/v1/admin/generate_link')[0].body, { type: 'magiclink', email: EMAIL });
    assert.deepEqual(f.callsTo('/rpc/svc_tg_link_get')[0].body, { p_telegram_id: TID });
  });

  test(`${label}：账号已不在（admin 404）→ unlinked，没叫 generate_link`, async () => {
    const f = routes({ admin: () => jsonRes(404, {}) });
    const r = await run({ initData: FRESH }, f);
    assert.deepEqual(r.body, { status: 'unlinked', label: LABEL, bindLeft: 500 });
    assert.equal(f.callsTo('/auth/v1/admin/generate_link').length, 0);
  });

  test(`${label}：账号不是邮箱登录、或没有邮箱 → 500，没叫 generate_link`, async () => {
    for (const u of [{ id: UID, email: EMAIL, app_metadata: { kind: 'anon' } }, { id: UID, email: EMAIL }, { id: UID, email: '', app_metadata: { kind: 'email' } }]) {
      const f = routes({ admin: () => jsonRes(200, u) });
      const r = await run({ initData: FRESH }, f);
      assert.equal(r.status, 500, JSON.stringify(u));
      assert.deepEqual(r.body, { error: '暂时无法登录，请稍后再试' });
      assert.equal(f.callsTo('/auth/v1/admin/generate_link').length, 0);
      assertCleanLogs(r.logs, 'kind');
    }
  });

  test(`${label}：admin 查人失败 → 500`, async () => {
    const r = await run({ initData: FRESH }, routes({ admin: () => jsonRes(500, {}) }));
    assert.equal(r.status, 500);
  });

  test(`${label}：generate_link 回的 id 不是这个人 → 500，没叫 verify`, async () => {
    const f = routes({ gl: () => jsonRes(200, { id: OTHER, verification_type: 'magiclink', hashed_token: 'HASHED' }) });
    const r = await run({ initData: FRESH }, f);
    assert.equal(r.status, 500);
    assert.equal(f.callsTo('/auth/v1/verify').length, 0);
    assertCleanLogs(r.logs, 'mismatch');
  });

  test(`${label}：generate_link 或 verify 429 → 429 请 1 分钟后再试`, async () => {
    for (const over of [{ gl: () => jsonRes(429, {}) }, { verify: () => jsonRes(429, {}) }]) {
      const r = await run({ initData: FRESH }, routes(over));
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { error: '请 1 分钟后再试' });
    }
  });

  test(`${label}：verify 500 → 500，回应不含 token`, async () => {
    const r = await run({ initData: FRESH }, routes({ verify: () => jsonRes(500, {}) }));
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes(AT));
  });

  test(`${label}：verify 之后连接不见了（中途被解除）→ 作废新 session、回 unlinked、回应不含 token`, async () => {
    for (const second of [() => jsonRes(200, null), () => jsonRes(200, OTHER)]) {
      const f = routes({ linkGets: [second] });
      const r = await run({ initData: FRESH }, f);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: 'unlinked', label: LABEL, bindLeft: 500 });
      const lo = f.callsTo('/auth/v1/logout');
      assert.equal(lo.length, 1);
      assert.equal(lo[0].url, `${BASE}/auth/v1/logout?scope=local`);
      assert.equal(lo[0].init.headers.Authorization, `Bearer ${AT}`);
      assert.ok(!r.text.includes(AT) && !r.text.includes(RT));
      assertCleanLogs(r.logs, '中途解除');
    }
  });

  test(`${label}：再查的 rpc 抛错（500、超时、回传不是 uuid）→ 作废新 session、回 500、回应不含 token`, async () => {
    for (const second of [() => jsonRes(500, {}), () => { throw new TypeError('net ' + EMAIL); }, () => jsonRes(200, { x: 1 })]) {
      const f = routes({ linkGets: [second] });
      const r = await run({ initData: FRESH }, f);
      assert.equal(r.status, 500);
      assert.equal(f.callsTo('/auth/v1/logout?scope=local').length, 1);
      assert.ok(!r.text.includes(AT) && !r.text.includes(RT));
      assertCleanLogs(r.logs, '再查失败');
    }
  });

  test(`${label}：作废失败也不会把 token 回给前端`, async () => {
    const f = routes({ linkGets: [() => jsonRes(200, null)], logout: () => jsonRes(500, {}) });
    const r = await run({ initData: FRESH }, f);
    assert.equal(r.body.status, 'unlinked');
    assert.ok(!r.text.includes(AT));
  });

  // ---------- rpc 失败 ----------

  test(`${label}：touch 失败、stale 的 link_get 失败、回传不是 uuid → 500，日志只有固定文字`, async () => {
    const cases = [
      [FRESH, { touch: () => jsonRes(500, { code: '55P03', message: EMAIL }) }],
      [FRESH, { touch: () => { throw new TypeError('boom ' + EMAIL); } }],
      [FRESH, { touch: () => jsonRes(200, 'not-a-uuid') }],
      [initDataAt(NOW - 301), { linkGets: [() => jsonRes(500, {})] }],
    ];
    for (const [d, over] of cases) {
      const f = routes(over);
      const r = await run({ initData: d }, f);
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: '暂时无法登录，请稍后再试' });
      assert.equal(f.callsTo('/auth/v1/').length, 0);
      assertCleanLogs(r.logs, 'rpc 失败');
      assert.ok(!r.logs.join('\n').includes('boom'), '外来错误讯息不能进日志');
    }
  });

  test(`${label}：touch 超时 → 500（rpc 有设超时）`, async () => {
    const seen = await withTimeouts(async () => {
      const r = await run({ initData: FRESH }, routes({ touch: hang }));
      assert.equal(r.status, 500);
    });
    assert.ok(seen.length >= 1 && seen[0] <= 4000, `rpc 超时 ${seen[0]}`);
  });

  // ---------- 回应的共通性质 ----------

  test(`${label}：每种回应都 no-store`, async () => {
    const outs = [
      await run({ initData: FRESH }, routes({ touch: () => jsonRes(200, null) })),
      await run({ initData: initDataAt(NOW - 301) }, routes()),
      await run({ initData: 'garbage' }, routes()),
      await run({ initData: FRESH }, routes({ gl: () => jsonRes(429, {}) })),
    ];
    for (const o of outs) assert.equal(o.res.headers.get('Cache-Control'), 'no-store', String(o.status));
  });
}
