// 3b-2：_shared/user.ts 的 adminGetUser、mintSession、revokeSession、logoutOthers
// generate_link／verify 的回应格式照 3b-1 实测（2026-11-26）：generate_link 顶层有 id、verification_type、hashed_token；
// verify 用 {type:'magiclink', token_hash}。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeFetch, jsonRes, hang } from './helpers/edge-fn.js';
import { adminGetUser, mintSession, revokeSession, logoutOthers } from '../supabase/functions/_shared/user.ts';
import { SHARED_IMPORT_FORBIDDEN } from '../scripts/build-functions.mjs';

const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'me@x.com';
const TOKEN = 'eyJ.user-access.sig';

// ---------------- adminGetUser ----------------

test('adminGetUser：GET /auth/v1/admin/users/<id>，只带 apikey（不带 Authorization）；email 小写、kind 取 app_metadata', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', () => jsonRes(200, { id: UID, email: 'Me@X.com', app_metadata: { kind: 'email' } })]]);
  assert.deepEqual(await adminGetUser(f, BASE, KEY, UID), { email: EMAIL, kind: 'email' });
  const c = f.calls[0];
  assert.equal(c.url, `${BASE}/auth/v1/admin/users/${UID}`);
  assert.equal(c.init.method ?? 'GET', 'GET');
  const h = new Headers(c.init.headers);
  assert.equal(h.get('apikey'), KEY);
  assert.equal(h.get('authorization'), null);
});

test('adminGetUser：user id 有 encodeURIComponent', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', () => jsonRes(404, {})]]);
  await adminGetUser(f, BASE, KEY, 'a/b?c');
  assert.equal(f.calls[0].url, `${BASE}/auth/v1/admin/users/a%2Fb%3Fc`);
});

test('adminGetUser：404 → gone', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', () => jsonRes(404, { error_code: 'user_not_found' })]]);
  assert.equal(await adminGetUser(f, BASE, KEY, UID), 'gone');
});

test('adminGetUser：500、内容坏掉、id 对不上、连线错 → error', async () => {
  const cases = [
    () => jsonRes(500, {}),
    () => new Response('not json', { status: 200 }),
    () => jsonRes(200, { id: OTHER, email: EMAIL }),
    () => { throw new TypeError('network'); },
  ];
  for (const h of cases) {
    const f = fakeFetch([['/auth/v1/admin/users/', h]]);
    assert.equal(await adminGetUser(f, BASE, KEY, UID), 'error');
  }
});

test('adminGetUser：缺 email、缺 app_metadata → 空字串', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', () => jsonRes(200, { id: UID })]]);
  assert.deepEqual(await adminGetUser(f, BASE, KEY, UID), { email: '', kind: '' });
});

test('adminGetUser：超时 → error', async () => {
  const f = fakeFetch([['/auth/v1/admin/users/', hang]]);
  const t0 = Date.now();
  assert.equal(await adminGetUser(f, BASE, KEY, UID, 50), 'error');
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------- mintSession ----------------

const glOk = (over = {}) => () => jsonRes(200, {
  id: UID, email: EMAIL, verification_type: 'magiclink', hashed_token: 'HASHED',
  action_link: 'https://p.supabase.co/auth/v1/verify?token=SECRET', email_otp: '123456', redirect_to: 'https://x', ...over,
});
const verifyOk = (over = {}) => () => jsonRes(200, {
  access_token: 'AT', refresh_token: 'RT', expires_in: 3600, expires_at: 1, token_type: 'bearer',
  user: { id: UID, email: 'Me@X.com', app_metadata: { kind: 'email' } }, ...over,
});
const logoutOk = () => new Response(null, { status: 204 });
const routes = (gl, verify, logout = logoutOk) => fakeFetch([
  ['/auth/v1/admin/generate_link', gl], ['/auth/v1/verify', verify], ['/auth/v1/logout', logout],
]);

test('mintSession：正常 → 只回 access_token、refresh_token、expires_in、user{id,email}', async () => {
  const f = routes(glOk(), verifyOk());
  const s = await mintSession(f, BASE, KEY, EMAIL, UID);
  assert.deepEqual(Object.keys(s).sort(), ['access_token', 'expires_in', 'refresh_token', 'user']);
  assert.deepEqual(Object.keys(s.user).sort(), ['email', 'id']);
  assert.deepEqual(s, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: UID, email: EMAIL } });
  assert.equal(f.callsTo('/auth/v1/logout').length, 0);
});

test('mintSession：generate_link 的 body 是 {type:magiclink, email}（没有 redirect_to）；只带 apikey', async () => {
  const f = routes(glOk(), verifyOk());
  await mintSession(f, BASE, KEY, EMAIL, UID);
  const c = f.callsTo('/auth/v1/admin/generate_link')[0];
  assert.equal(c.url, `${BASE}/auth/v1/admin/generate_link`);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.body, { type: 'magiclink', email: EMAIL });
  const h = new Headers(c.init.headers);
  assert.equal(h.get('apikey'), KEY);
  assert.equal(h.get('authorization'), null);
});

test('mintSession：verify 的 body 是 {type:magiclink, token_hash}', async () => {
  const f = routes(glOk(), verifyOk());
  await mintSession(f, BASE, KEY, EMAIL, UID);
  const c = f.callsTo('/auth/v1/verify')[0];
  assert.equal(c.url, `${BASE}/auth/v1/verify`);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.body, { type: 'magiclink', token_hash: 'HASHED' });
});

test('mintSession：generate_link 回的 id 不是预期的人 → mismatch，没有叫 verify', async () => {
  const f = routes(glOk({ id: OTHER }), verifyOk());
  assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'mismatch');
  assert.equal(f.callsTo('/auth/v1/verify').length, 0);
});

test('mintSession：generate_link 缺 id、verification_type 不是 magiclink → mismatch，没有叫 verify', async () => {
  for (const over of [{ id: undefined }, { verification_type: 'signup' }, { verification_type: undefined }]) {
    const f = routes(glOk(over), verifyOk());
    assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'mismatch', JSON.stringify(over));
    assert.equal(f.callsTo('/auth/v1/verify').length, 0);
  }
});

test('mintSession：verify 回来的 user.id 不是预期的人 → 先作废这个 session（scope=local）再回 mismatch', async () => {
  const f = routes(glOk(), verifyOk({ user: { id: OTHER, email: 'o@x.com' } }));
  assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'mismatch');
  const lo = f.callsTo('/auth/v1/logout');
  assert.equal(lo.length, 1);
  assert.equal(lo[0].url, `${BASE}/auth/v1/logout?scope=local`);
  assert.equal(new Headers(lo[0].init.headers).get('authorization'), 'Bearer AT');
});

test('mintSession：generate_link 429、verify 429 → limited', async () => {
  assert.equal(await mintSession(routes(() => jsonRes(429, {}), verifyOk()), BASE, KEY, EMAIL, UID), 'limited');
  assert.equal(await mintSession(routes(glOk(), () => jsonRes(429, {})), BASE, KEY, EMAIL, UID), 'limited');
});

test('mintSession：generate_link 缺 hashed_token、500、连线错 → error，没有叫 verify', async () => {
  for (const gl of [glOk({ hashed_token: undefined }), glOk({ hashed_token: '' }), () => jsonRes(500, {}), () => { throw new TypeError('x'); }]) {
    const f = routes(gl, verifyOk());
    assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'error');
    assert.equal(f.callsTo('/auth/v1/verify').length, 0);
  }
});

test('mintSession：verify 缺 token、expires_in 不是数字、500、连线错 → error', async () => {
  for (const v of [verifyOk({ access_token: undefined }), verifyOk({ refresh_token: '' }), verifyOk({ expires_in: '3600' }), () => jsonRes(500, {}), () => { throw new TypeError('x'); }]) {
    assert.equal(await mintSession(routes(glOk(), v), BASE, KEY, EMAIL, UID), 'error');
  }
});

test('mintSession：verify 有 access_token 但内容不完整 → 先作废它再回 error', async () => {
  const f = routes(glOk(), verifyOk({ refresh_token: undefined }));
  assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'error');
  assert.equal(f.callsTo('/auth/v1/logout?scope=local').length, 1);
});

test('mintSession：超时 → error', async () => {
  const t0 = Date.now();
  assert.equal(await mintSession(routes(hang, verifyOk()), BASE, KEY, EMAIL, UID, 50), 'error');
  assert.equal(await mintSession(routes(glOk(), hang), BASE, KEY, EMAIL, UID, 50), 'error');
  assert.ok(Date.now() - t0 < 2000);
});

test('mintSession：不写任何日志（hashed_token、action_link、邮箱都不会进 console）', async () => {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  try {
    await mintSession(routes(glOk(), verifyOk()), BASE, KEY, EMAIL, UID);
    await mintSession(routes(glOk({ id: OTHER }), verifyOk()), BASE, KEY, EMAIL, UID);
    await mintSession(routes(glOk(), verifyOk({ user: { id: OTHER } })), BASE, KEY, EMAIL, UID);
    await mintSession(routes(() => { throw new TypeError('HASHED ' + EMAIL); }, verifyOk()), BASE, KEY, EMAIL, UID);
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(logs, []);
});

// ---------------- revokeSession／logoutOthers ----------------

for (const [name, fn, scope] of [['revokeSession', revokeSession, 'local'], ['logoutOthers', logoutOthers, 'others']]) {
  test(`${name}：POST /auth/v1/logout?scope=${scope}，apikey＋用户 token；204 → true`, async () => {
    const f = fakeFetch([['/auth/v1/logout', logoutOk]]);
    assert.equal(await fn(f, BASE, KEY, TOKEN), true);
    const c = f.calls[0];
    assert.equal(c.url, `${BASE}/auth/v1/logout?scope=${scope}`);
    assert.equal(c.init.method, 'POST');
    const h = new Headers(c.init.headers);
    assert.equal(h.get('apikey'), KEY);
    assert.equal(h.get('authorization'), `Bearer ${TOKEN}`);
  });

  test(`${name}：401、500、连线错、超时 → false`, async () => {
    for (const h of [() => jsonRes(401, {}), () => jsonRes(500, {}), () => { throw new TypeError('x'); }, hang]) {
      const f = fakeFetch([['/auth/v1/logout', h]]);
      assert.equal(await fn(f, BASE, KEY, TOKEN, 50), false);
    }
  });
}

test('user.ts 符合 _shared 打包规则：不 import 别档', () => {
  const src = readFileSync(new URL('../supabase/functions/_shared/user.ts', import.meta.url), 'utf8');
  assert.equal(SHARED_IMPORT_FORBIDDEN.test(src), false);
});

test('mintSession：verify 回 200 有 token 但没有 user → 先作废再回 mismatch', async () => {
  const f = routes(glOk(), verifyOk({ user: undefined }));
  assert.equal(await mintSession(f, BASE, KEY, EMAIL, UID), 'mismatch');
  assert.equal(f.callsTo('/auth/v1/logout?scope=local').length, 1);
});

test('mintSession：第 7 个参数是内部作废的超时', async () => {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  const f = routes(glOk(), verifyOk({ user: { id: OTHER } }));
  try { await mintSession(f, BASE, KEY, EMAIL, UID, 2500, 1500); } finally { AbortSignal.timeout = orig; }
  assert.deepEqual(seen, [2500, 2500, 1500]);
});
