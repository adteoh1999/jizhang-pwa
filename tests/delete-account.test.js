import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, hang, envOf } from './helpers/edge-fn.js';
import { getUser, deleteAuthUser, bearer } from '../supabase/functions/_shared/user.ts';

const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const ENV = envOf({ SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}` });
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'eyJ.test-access-token.sig';
const EMAIL = 'me@x.com';

const userOk = () => jsonRes(200, { id: USER_ID, email: 'Me@X.com', app_metadata: { kind: 'email' } });

// ---------------- _shared/user.ts ----------------

test('getUser：带 apikey 与 Bearer token 叫 GET /auth/v1/user；email 转小写、kind 取 app_metadata', async () => {
  const f = fakeFetch([['/auth/v1/user', userOk]]);
  const u = await getUser(f, BASE, KEY, TOKEN);
  assert.deepEqual(u, { id: USER_ID, email: EMAIL, kind: 'email' });
  const c = f.calls[0];
  assert.equal(c.url, `${BASE}/auth/v1/user`);
  assert.equal(c.init.method ?? 'GET', 'GET');
  assert.equal(c.init.headers.apikey, KEY);
  assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('getUser：缺 app_metadata → kind 是空字串；缺 email → 空字串', async () => {
  const f = fakeFetch([['/auth/v1/user', () => jsonRes(200, { id: USER_ID })]]);
  assert.deepEqual(await getUser(f, BASE, KEY, TOKEN), { id: USER_ID, email: '', kind: '' });
});

test('getUser：401 → unauthorized；403 其他原因 → unauthorized', async () => {
  for (const res of [jsonRes(401, { msg: 'invalid JWT' }), jsonRes(403, { error_code: 'bad_jwt' }), jsonRes(403)]) {
    const f = fakeFetch([['/auth/v1/user', () => res]]);
    assert.equal(await getUser(f, BASE, KEY, TOKEN), 'unauthorized');
  }
});

test('getUser：403 且 error_code 是 user_not_found（账号已被删）→ gone', async () => {
  const f = fakeFetch([['/auth/v1/user', () => jsonRes(403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' })]]);
  assert.equal(await getUser(f, BASE, KEY, TOKEN), 'gone');
});

test('getUser：500、内容坏掉、缺 id、连线失败、超时 → error', async () => {
  const cases = [
    () => jsonRes(500, {}),
    () => new Response('not json', { status: 200 }),
    () => jsonRes(200, { email: EMAIL }),
    () => { throw new TypeError('network'); },
  ];
  for (const h of cases) {
    const f = fakeFetch([['/auth/v1/user', h]]);
    assert.equal(await getUser(f, BASE, KEY, TOKEN), 'error');
  }
  const f = fakeFetch([['/auth/v1/user', hang]]);
  assert.equal(await getUser(f, BASE, KEY, TOKEN, 30), 'error');
});

test('deleteAuthUser：DELETE admin/users/<id>，2xx 或 404 → true；其他 → false', async () => {
  for (const [res, want] of [[jsonRes(200, {}), true], [jsonRes(204), true], [jsonRes(404, { error_code: 'user_not_found' }), true],
                             [jsonRes(500, {}), false], [jsonRes(401, {}), false]]) {
    const f = fakeFetch([['/auth/v1/admin/users/', () => res]]);
    assert.equal(await deleteAuthUser(f, BASE, KEY, USER_ID), want);
    assert.equal(f.calls[0].url, `${BASE}/auth/v1/admin/users/${USER_ID}`);
    assert.equal(f.calls[0].init.method, 'DELETE');
    assert.equal(f.calls[0].init.headers.apikey, KEY);
  }
});

test('deleteAuthUser：连线失败或超时 → false', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', () => { throw new TypeError('network'); }]]);
  assert.equal(await deleteAuthUser(f, BASE, KEY, USER_ID), false);
  const g = fakeFetch([['/auth/v1/admin/users/', hang]]);
  assert.equal(await deleteAuthUser(g, BASE, KEY, USER_ID, 30), false);
});

test('bearer：取 Authorization: Bearer 后面的 token；没有或格式不对 → null', () => {
  const r = (h) => new Request(`${BASE}/x`, { headers: h });
  assert.equal(bearer(r({ Authorization: `Bearer ${TOKEN}` })), TOKEN);
  assert.equal(bearer(r({ authorization: `bearer ${TOKEN}` })), TOKEN);
  assert.equal(bearer(r({})), null);
  assert.equal(bearer(r({ Authorization: 'Basic abc' })), null);
  assert.equal(bearer(r({ Authorization: 'Bearer ' })), null);
});

// ---------------- delete-account ----------------

const req = ({ origin = ORIGIN, method = 'POST', token = TOKEN } = {}) => new Request(`${BASE}/functions/v1/delete-account`, {
  method,
  headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});

function routes({ user = userOk, rpcRes = () => jsonRes(204), admin = () => jsonRes(200, {}) } = {}) {
  return fakeFetch([
    ['/auth/v1/admin/users/', admin],
    ['/auth/v1/user', user],
    ['/rpc/svc_delete_user_data', rpcRes],
  ]);
}

for (const [label, mod] of await loadBoth('delete-account')) {
  const run = (r, f, extra = {}) => mod.handleDeleteAccount(r, { env: ENV, fetch: f, ...extra });

  test(`${label}：OPTIONS → 204，带 CORS header`, async () => {
    const res = await run(req({ method: 'OPTIONS' }), routes());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.match(res.headers.get('Access-Control-Allow-Headers'), /authorization/);
  });

  test(`${label}：来源不在名单 → 没有 allow-origin`, async () => {
    const res = await run(req({ method: 'OPTIONS', origin: 'https://evil.example' }), routes());
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  });

  test(`${label}：GET → 405`, async () => {
    const res = await run(req({ method: 'GET' }), routes());
    assert.equal(res.status, 405);
  });

  test(`${label}：没有 token → 401，没叫任何服务`, async () => {
    const f = routes();
    const res = await run(req({ token: null }), f);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: '请重新登录后再试' });
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：/auth/v1/user 回 401 → 401，没叫 rpc 与 admin`, async () => {
    const f = routes({ user: () => jsonRes(401, {}) });
    const res = await run(req(), f);
    assert.equal(res.status, 401);
    assert.equal(f.callsTo('/rpc/').length, 0);
    assert.equal(f.callsTo('/admin/').length, 0);
  });

  test(`${label}：/auth/v1/user 回 403 其他原因 → 401`, async () => {
    const f = routes({ user: () => jsonRes(403, { error_code: 'session_not_found' }) });
    const res = await run(req(), f);
    assert.equal(res.status, 401);
  });

  test(`${label}：重试时账号已不存在（403 user_not_found）→ 200，没叫 rpc 与 admin`, async () => {
    const f = routes({ user: () => jsonRes(403, { error_code: 'user_not_found' }) });
    const res = await run(req(), f);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(f.callsTo('/rpc/').length, 0);
    assert.equal(f.callsTo('/admin/').length, 0);
  });

  test(`${label}：/auth/v1/user 回 500 → 500，没叫 rpc`, async () => {
    const f = routes({ user: () => jsonRes(500, {}) });
    const res = await run(req(), f);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '暂时无法删除，请稍后再试' });
    assert.equal(f.callsTo('/rpc/').length, 0);
  });

  test(`${label}：成功：依序 user → svc_delete_user_data → DELETE admin/users/<id>，回 200`, async () => {
    const f = routes();
    const res = await run(req(), f);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const order = f.calls.map((c) => c.url.replace(BASE, ''));
    assert.deepEqual(order, ['/auth/v1/user', '/rest/v1/rpc/svc_delete_user_data', `/auth/v1/admin/users/${USER_ID}`]);
    assert.deepEqual(f.calls[1].body, { p_user_id: USER_ID });
    assert.equal(f.calls[1].init.headers['Content-Profile'], 'svc');
    assert.equal(f.calls[2].init.method, 'DELETE');
    // rpc 与 admin 只用 secret key，不带用户 token
    for (const c of f.calls.slice(1)) {
      assert.equal(c.init.headers.apikey, KEY);
      assert.equal(c.init.headers.Authorization, undefined);
    }
  });

  test(`${label}：各步超时：身份 3 秒、删资料 5 秒、删账号 5 秒`, async () => {
    const orig = AbortSignal.timeout;
    const seen = [];
    AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
    let res;
    try { res = await run(req(), routes()); } finally { AbortSignal.timeout = orig; }
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [3000, 5000, 5000]);
  });

  test(`${label}：admin 回 404（上次已删掉）也算成功`, async () => {
    const f = routes({ admin: () => jsonRes(404, { error_code: 'user_not_found' }) });
    const res = await run(req(), f);
    assert.equal(res.status, 200);
  });

  test(`${label}：rpc 失败 → 500，没叫 admin 删除`, async () => {
    const f = routes({ rpcRes: () => jsonRes(500, { message: 'boom' }) });
    const res = await run(req(), f);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '暂时无法删除，请稍后再试' });
    assert.equal(f.callsTo('/admin/').length, 0);
  });

  test(`${label}：admin 回 500 或超时 → 500`, async () => {
    const f = routes({ admin: () => jsonRes(500, {}) });
    assert.equal((await run(req(), f)).status, 500);
    const g = routes({ admin: hang });
    assert.equal((await run(req(), g, { adminTimeoutMs: 30 })).status, 500);
  });

  test(`${label}：缺设定 → 500，没叫任何服务`, async () => {
    const f = routes();
    const res = await mod.handleDeleteAccount(req(), { env: envOf({}), fetch: f });
    assert.equal(res.status, 500);
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：日志不含 token、邮箱、key、user id`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try {
      await run(req(), routes({ user: () => jsonRes(500, { msg: EMAIL }) }));
      await run(req(), routes({ rpcRes: () => jsonRes(500, { message: EMAIL }) }));
      await run(req(), routes({ admin: () => jsonRes(500, { msg: EMAIL }) }));
    } finally { console.error = orig; }
    assert.ok(logs.length >= 3, '每种失败都要留一行日志');
    for (const l of logs) {
      for (const secret of [TOKEN, EMAIL, KEY, USER_ID]) assert.ok(!l.includes(secret), `日志含敏感资料：${l}`);
    }
  });
}
