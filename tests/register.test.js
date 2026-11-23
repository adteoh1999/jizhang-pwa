import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, hang, envOf } from './helpers/edge-fn.js';
import { clientIp } from '../supabase/functions/_shared/http.ts';

const ORIGIN = 'https://jizhang.adteoh.com';
const ENV = envOf({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}' });
const USER_ID = '11111111-1111-4111-8111-111111111111';

const req = (body, { origin = ORIGIN, method = 'POST' } = {}) => new Request('https://p.supabase.co/functions/v1/register', {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

function routes({
  check = { limited: false, exists: false, owner: false },
  check2,
  redeem = true,
  create = () => jsonRes(200, { id: USER_ID, email: 'me@x.com' }),
} = {}) {
  let n = 0;
  return fakeFetch([
    ['/rpc/svc_register_check', () => jsonRes(200, (n++ === 0 || !check2) ? check : check2)],
    ['/rpc/svc_redeem_invite', () => jsonRes(200, redeem)],
    ['/rpc/svc_refund_invite', () => jsonRes(204)],
    ['/rpc/svc_record_invite_use', () => jsonRes(204)],
    ['/auth/v1/admin/users', create],
  ]);
}

// 2026-11-23 实测：Supabase 前面是 Cloudflare，cf-connecting-ip 由 Cloudflare 填，用户自己送会被拒（403）；
// x-forwarded-for 会被平台重写；true-client-ip 会原样透传（能伪造），不能用。
test('clientIp：取 cf-connecting-ip（IPv4）', () => {
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '115.133.58.181' })), '115.133.58.181');
});

test('clientIp：IPv6 也可以，并去掉前后空白', () => {
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': ' 2001:db8::1 ' })), '2001:db8::1');
});

test('clientIp：不看能伪造的 header', () => {
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4', 'true-client-ip': '8.8.4.4', 'x-real-ip': '9.9.9.9' })), null);
});

test('clientIp：有 cf-connecting-ip 时，优先用它，不管其他 header', () => {
  const h = new Headers({ 'cf-connecting-ip': '115.133.58.181', 'true-client-ip': '8.8.4.4', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(clientIp(h), '115.133.58.181');
});

test('clientIp：IPv6 转小写；完整 39 字也可以', () => {
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '2001:DB8::ABCD' })), '2001:db8::abcd');
  const full = '2001:0db8:0000:0000:0000:ff00:0042:8329';
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': full })), full);
});

test('clientIp：::ffff:1.2.3.4 放行（数据库会当成 IPv4）', () => {
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '::ffff:1.2.3.4' })), '::ffff:1.2.3.4');
});

test('clientIp：长度 45 可以、46 不行', () => {
  const v45 = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
  assert.equal(v45.length, 45);
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': v45 })), v45);
  assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '0' + v45 })), null);
});

test('clientIp：格式怪的值 → null', () => {
  for (const v of ['', '   ', 'abc', '1.2.3.4, 5.6.7.8', '1.2.3.4;x', 'x'.repeat(46), '1.2.3', '1.2.3.4.5',
                   '999.1.1.1', '1.2.3.4:8080', 'fe80::1%eth0', '[::1]', '1:2']) {
    assert.equal(clientIp(new Headers({ 'cf-connecting-ip': v })), null, v);
  }
});

for (const [label, mod] of await loadBoth('register')) {
  const run = (r, f, extra = {}) => mod.handleRegister(r, { env: ENV, fetch: f, ...extra });
  const body = async (res) => res.json();

  test(`${label}：坏邮箱 → 400`, async () => {
    const f = routes();
    const res = await run(req({ email: 'abc' }), f);
    assert.equal(res.status, 400);
    assert.deepEqual(await body(res), { error: '邮箱格式不对' });
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：body 不是 JSON → 400`, async () => {
    const res = await run(req('not json'), routes());
    assert.equal(res.status, 400);
  });

  test(`${label}：有 cf-connecting-ip → 第一次检查带 IP，复查不带`, async () => {
    const f = routes({ create: () => jsonRes(500, {}) });
    const r = req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' });
    r.headers.set('cf-connecting-ip', '115.133.58.181');
    await run(r, f);
    assert.equal(f.callsTo('svc_register_check')[0].body.p_ip, '115.133.58.181');
    assert.deepEqual(f.callsTo('svc_register_check')[1].body, { p_email: 'me@x.com', p_ip: null, p_count: false });
  });

  test(`${label}：cf-connecting-ip 是怪值 → 第一次检查 p_ip 为 null，并写一行固定日志`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    const f = routes();
    try {
      const r = req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' });
      r.headers.set('cf-connecting-ip', 'garbage-LEAK');
      await run(r, f);
    } finally { console.error = orig; }
    assert.equal(f.callsTo('svc_register_check')[0].body.p_ip, null);
    assert.ok(logs.some((l) => /取不到 IP/.test(l)));
    for (const l of logs) assert.doesNotMatch(l, /LEAK|me@x\.com|K7MPQ4XZ/);
  });

  test(`${label}：IP 太多次 → 429`, async () => {
    const f = routes({ check: { limited: true, exists: false, owner: false } });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 429);
    assert.deepEqual(await body(res), { error: '尝试太多次，请稍后再试' });
    assert.equal(f.callsTo('svc_redeem_invite').length, 0);
  });

  test(`${label}：没有 IP 时传 null，邮箱已正规化`, async () => {
    const f = routes({ check: { limited: false, exists: true, owner: false } });
    await run(req({ email: ' Me@X.com ' }), f);
    assert.deepEqual(f.callsTo('svc_register_check')[0].body, { p_email: 'me@x.com', p_ip: null });
  });

  test(`${label}：已有账号 → 200，不扣码、不建账号`, async () => {
    const f = routes({ check: { limited: false, exists: true, owner: false } });
    const res = await run(req({ email: 'me@x.com' }), f);
    assert.equal(res.status, 200);
    assert.deepEqual(await body(res), { ok: true });
    assert.equal(f.callsTo('svc_redeem_invite').length, 0);
    assert.equal(f.callsTo('/auth/v1/admin/users').length, 0);
  });

  test(`${label}：站主不需要邀请码`, async () => {
    const f = routes({ check: { limited: false, exists: false, owner: true } });
    const res = await run(req({ email: 'me@x.com' }), f);
    assert.equal(res.status, 200);
    assert.equal(f.callsTo('svc_redeem_invite').length, 0);
    assert.equal(f.callsTo('/auth/v1/admin/users').length, 1);
    assert.equal(f.callsTo('svc_record_invite_use').length, 0);
  });

  test(`${label}：没有邀请码或格式不对 → 403，不扣码`, async () => {
    for (const code of [undefined, '', 'K7MPQ4XO']) {
      const f = routes();
      const res = await run(req({ email: 'me@x.com', invite_code: code }), f);
      assert.equal(res.status, 403);
      assert.deepEqual(await body(res), { error: '需要有效的邀请码' });
      assert.equal(f.callsTo('svc_redeem_invite').length, 0);
    }
  });

  test(`${label}：邀请码无效（扣码失败）→ 403，不建账号`, async () => {
    const f = routes({ redeem: false });
    const res = await run(req({ email: 'me@x.com', invite_code: 'k7mp-q4xz' }), f);
    assert.equal(res.status, 403);
    assert.deepEqual(f.callsTo('svc_redeem_invite')[0].body, { p_code: 'K7MPQ4XZ', p_email: 'me@x.com' });
    assert.equal(f.callsTo('/auth/v1/admin/users').length, 0);
  });

  test(`${label}：建账号成功 → 记录使用，回 200；建账号内容正确`, async () => {
    const f = routes();
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 200);
    const [c] = f.callsTo('/auth/v1/admin/users');
    assert.equal(c.url, 'https://p.supabase.co/auth/v1/admin/users');
    assert.equal(c.init.method, 'POST');
    assert.equal(new Headers(c.init.headers).get('apikey'), 'sb_secret_test');
    assert.deepEqual(c.body, { email: 'me@x.com', email_confirm: true, app_metadata: { kind: 'email' } });
    assert.deepEqual(f.callsTo('svc_record_invite_use')[0].body, { p_code: 'K7MPQ4XZ', p_email: 'me@x.com', p_user_id: USER_ID });
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号明确失败、复查也没有账号 → 退码，回 500`, async () => {
    const f = routes({ create: () => jsonRes(400, { code: 'validation_failed', msg: 'x' }) });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_register_check').length, 2);
    assert.deepEqual(f.callsTo('svc_register_check')[1].body, { p_email: 'me@x.com', p_ip: null, p_count: false });
    assert.deepEqual(f.callsTo('svc_refund_invite')[0].body, { p_code: 'K7MPQ4XZ', p_email: 'me@x.com' });
  });

  test(`${label}：建账号明确失败、但复查发现已有账号（另一个请求建的）→ 不退码，回 200`, async () => {
    const f = routes({ create: () => jsonRes(400, { code: 'x' }), check2: { limited: false, exists: true, owner: false } });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 200);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号明确失败、复查也失败 → 500，不退码`, async () => {
    let n = 0;
    const f = fakeFetch([
      ['/rpc/svc_register_check', () => (n++ === 0 ? jsonRes(200, { limited: false, exists: false, owner: false }) : jsonRes(500, {}))],
      ['/rpc/svc_redeem_invite', () => jsonRes(200, true)],
      ['/rpc/svc_refund_invite', () => jsonRes(204)],
      ['/auth/v1/admin/users', () => jsonRes(400, {})],
    ]);
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号回「已存在」→ 不退码，回 200`, async () => {
    const f = routes({ create: () => jsonRes(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' }) });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 200);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号超时、但其实已建成 → 不退码，回 200`, async () => {
    const f = routes({ create: hang, check2: { limited: false, exists: true, owner: false } });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f, { adminTimeoutMs: 50 });
    assert.equal(res.status, 200);
    assert.equal(f.callsTo('svc_register_check').length, 2);
    assert.deepEqual(f.callsTo('svc_register_check')[1].body, { p_email: 'me@x.com', p_ip: null, p_count: false });  // 复查不算次数
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号回 503（结果不明）、复查也没有账号 → 一律不退码，回 500`, async () => {
    const f = routes({ create: () => jsonRes(503, {}) });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_register_check').length, 2);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号超时、复查也没有账号 → 一律不退码，回 500`, async () => {
    const f = routes({ create: hang });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f, { adminTimeoutMs: 50 });
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：建账号回 408（请求超时，结果不明）→ 不退码`, async () => {
    const f = routes({ create: () => jsonRes(408, {}) });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：检查的 rpc 失败 → 500`, async () => {
    const f = fakeFetch([['/rpc/svc_register_check', () => jsonRes(500, {})]]);
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
  });

  test(`${label}：「已存在」的新版格式与只有讯息的格式 → 都不退码，回 200`, async () => {
    for (const b of [{ code: 'email_exists', message: 'x' }, { msg: 'A user with this email address has already been registered' }]) {
      const f = routes({ create: () => jsonRes(422, b) });
      const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
      assert.equal(res.status, 200);
      assert.equal(f.callsTo('svc_refund_invite').length, 0);
    }
  });

  test(`${label}：建账号成功但没有 id → 仍回 200，不记录、不退码`, async () => {
    const f = routes({ create: () => jsonRes(200, {}) });
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 200);
    assert.equal(f.callsTo('svc_record_invite_use').length, 0);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：记录使用失败 → 仍回 200`, async () => {
    const f = routes();
    const f2 = fakeFetch([['/rpc/svc_record_invite_use', () => jsonRes(500, {})], ['', (u, i) => f(u, i)]]);
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f2);
    assert.equal(res.status, 200);
  });

  test(`${label}：结果不明、复查也失败 → 500，不退码`, async () => {
    let n = 0;
    const f = fakeFetch([
      ['/rpc/svc_register_check', () => (n++ === 0 ? jsonRes(200, { limited: false, exists: false, owner: false }) : jsonRes(500, {}))],
      ['/rpc/svc_redeem_invite', () => jsonRes(200, true)],
      ['/rpc/svc_refund_invite', () => jsonRes(204)],
      ['/auth/v1/admin/users', () => jsonRes(503, {})],
    ]);
    const res = await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('svc_refund_invite').length, 0);
  });

  test(`${label}：邀请码传数字或物件 → 403`, async () => {
    for (const code of [12345678, { a: 1 }, ['K7MPQ4XZ']]) {
      const f = routes();
      const res = await run(req({ email: 'me@x.com', invite_code: code }), f);
      assert.equal(res.status, 403);
      assert.equal(f.callsTo('svc_redeem_invite').length, 0);
    }
  });

  test(`${label}：建账号回 401 → 日志写出状态码，但不含邮箱和 key`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try {
      await run(req({ email: 'me@x.com', invite_code: 'K7MPQ4XZ' }), routes({ create: () => jsonRes(401, { code: 'no_authorization' }) }));
    } finally { console.error = orig; }
    assert.ok(logs.some((l) => /401/.test(l)), '日志要有 401');
    for (const l of logs) assert.doesNotMatch(l, /me@x\.com|sb_secret|K7MPQ4XZ/);
  });

  test(`${label}：OPTIONS → 204，带 CORS header`, async () => {
    const res = await run(req(null, { method: 'OPTIONS' }), routes());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
    assert.match(res.headers.get('access-control-allow-headers'), /apikey/);
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  });

  test(`${label}：本机测试来源也允许`, async () => {
    const res = await run(req({ email: 'abc' }, { origin: 'http://localhost:8000' }), routes());
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8000');
  });

  test(`${label}：来源不在名单 → 没有 allow-origin`, async () => {
    const res = await run(req({ email: 'abc' }, { origin: 'https://evil.example' }), routes());
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const opt = await run(req(null, { origin: 'https://evil.example', method: 'OPTIONS' }), routes());
    assert.equal(opt.headers.get('access-control-allow-origin'), null);
  });

  test(`${label}：一般回应也带 allow-origin 和 content-type`, async () => {
    const res = await run(req({ email: 'me@x.com' }), routes({ check: { limited: false, exists: true, owner: false } }));
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });

  test(`${label}：GET → 405`, async () => {
    const res = await run(req(null, { method: 'GET' }), routes());
    assert.equal(res.status, 405);
  });
}
