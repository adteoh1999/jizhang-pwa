import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadBoth, fakeFetch, jsonRes, hang, HOOK_SECRET, signedRequest, envOf } from './helpers/edge-fn.js';

const NOW = 1_800_000_000;
const ENV = envOf({
  SUPABASE_URL: 'https://p.supabase.co',
  SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}',
  SEND_EMAIL_HOOK_SECRET: HOOK_SECRET,
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: '记账 <noreply@mail.example.com>',
});
const payload = (over = {}) => ({
  user: { email: ' Me@X.COM ' },
  email_data: { token: '123456', email_action_type: 'magiclink', ...over },
});

function routes({ reserve = () => jsonRes(200, { ok: true, id: 42 }), resend = () => jsonRes(200, { id: 'e1' }) } = {}) {
  return fakeFetch([
    ['/rpc/svc_otp_reserve', reserve],
    ['/rpc/svc_otp_release', () => jsonRes(204)],
    ['api.resend.com', resend],
  ]);
}

for (const [label, mod] of await loadBoth('send-email')) {
  const run = (req, f, timeouts) => mod.handleSendEmail(req, { env: ENV, fetch: f, nowSec: () => NOW, ...timeouts });

  test(`${label}：签名不对 → 401，不寄信`, async () => {
    const f = routes();
    const res = await run(signedRequest(payload(), NOW, { key: randomBytes(32) }), f);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(f.callsTo('api.resend.com').length, 0);
    assert.equal(f.callsTo('/rpc/').length, 0);
  });

  test(`${label}：签名不对的回应格式`, async () => {
    const res = await run(signedRequest(payload(), NOW, { key: randomBytes(32) }), routes());
    assert.deepEqual(await res.json(), { error: { http_code: 401, message: '签名不对' } });
  });

  test(`${label}：只寄 spec 允许的类型（magiclink、signup、email、reauthentication）`, async () => {
    for (const t of ['magiclink', 'signup', 'email', 'reauthentication']) {
      const f = routes();
      const res = await run(signedRequest(payload({ email_action_type: t }), NOW), f);
      assert.equal(res.status, 200, t);
      assert.equal(f.callsTo('api.resend.com').length, 1, t);
    }
  });

  // Auth 源码（supabase/auth internal/hooks/hookshttp.go）：钩子回 HTTP 429 会被改成 500、讯息丢掉；
  // 回 HTTP 200 + {"error":{"http_code":429,"message":…}} 才会把 429 和讯息传给前端（hookserrors.go）。
  test(`${label}：其他类型（recovery、invite、没写）→ 200 + error 403（非空讯息），不寄信、不算次数`, async () => {
    for (const t of ['recovery', 'invite', 'email_change_new', undefined]) {
      const f = routes();
      const res = await run(signedRequest(payload({ email_action_type: t }), NOW), f);
      assert.equal(res.status, 200, String(t));
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), { error: { http_code: 403, message: '不支持这个操作' } }, String(t));
      assert.equal(f.calls.length, 0, String(t));
    }
  });

  test(`${label}：更换邮箱 → 200 + error 403，不寄信`, async () => {
    const f = routes();
    const res = await run(signedRequest(payload({ email_action_type: 'email_change' }), NOW), f);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).error.http_code, 403);
    assert.equal(f.callsTo('api.resend.com').length, 0);
  });

  test(`${label}：限流挡下 → 200 + error 429 原讯息（Auth 会转成 429 给前端），不带 retry-after`, async () => {
    const f = routes({ reserve: () => jsonRes(200, { ok: false, message: '请 42 秒后再试' }) });
    const res = await run(signedRequest(payload(), NOW), f);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('retry-after'), null);
    assert.deepEqual(await res.json(), { error: { http_code: 429, message: '请 42 秒后再试' } });
    assert.equal(f.callsTo('api.resend.com').length, 0);
  });

  // Auth（hookserrors.go）：200 回应里 error.message 不是非空字串，就当成「寄信成功」。所以拒绝一定要有讯息。
  test(`${label}：限流挡下但讯息缺少 / 空白 / 不是字串 / 太长 → 换成固定句子`, async () => {
    for (const bad of [undefined, '', '   ', 42, { a: 1 }, ['x'], 'x'.repeat(101)]) {
      const f = routes({ reserve: () => jsonRes(200, { ok: false, message: bad }) });
      const res = await run(signedRequest(payload(), NOW), f);
      assert.equal(res.status, 200, JSON.stringify(bad));
      assert.deepEqual(await res.json(), { error: { http_code: 429, message: '请稍后再试' } }, JSON.stringify(bad));
      assert.equal(f.callsTo('api.resend.com').length, 0);
    }
    const f = routes({ reserve: () => jsonRes(200, null) });
    const res = await run(signedRequest(payload(), NOW), f);
    assert.deepEqual(await res.json(), { error: { http_code: 429, message: '请稍后再试' } });
  });

  test(`${label}：总规则——回 200 时，要嘛是 {} 且寄了一封，要嘛有非空 error.message 且没寄信`, async () => {
    const cases = [
      [payload(), {}],
      [payload({ email_action_type: 'recovery' }), {}],
      [payload(), { reserve: () => jsonRes(200, { ok: false, message: '请 9 秒后再试' }) }],
      [payload(), { reserve: () => jsonRes(200, { ok: false }) }],
    ];
    for (const [p, r] of cases) {
      const f = routes(r);
      const res = await run(signedRequest(p, NOW), f);
      if (res.status !== 200) continue;
      const body = await res.json();
      const sent = f.callsTo('api.resend.com').length;
      if (body.error) {
        assert.equal(typeof body.error.message, 'string');
        assert.ok(body.error.message.trim().length > 0);
        assert.equal(sent, 0);
      } else {
        assert.deepEqual(body, {});
        assert.equal(sent, 1);
      }
    }
  });

  test(`${label}：正常 → 寄信、回 200 {}`, async () => {
    const f = routes();
    const res = await run(signedRequest(payload(), NOW), f);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), {});
    assert.deepEqual(f.callsTo('/rpc/svc_otp_reserve')[0].body, { p_email: 'me@x.com' });
    const [mail] = f.callsTo('api.resend.com');
    assert.equal(mail.url, 'https://api.resend.com/emails');
    assert.equal(new Headers(mail.init.headers).get('authorization'), 'Bearer re_test');
    assert.equal(mail.body.from, '记账 <noreply@mail.example.com>');
    assert.deepEqual(mail.body.to, ['me@x.com']);
    assert.equal(mail.body.subject, '你的记账验证码');
    assert.match(mail.body.html, /123456/);
    assert.match(mail.body.text, /123456/);
    assert.match(mail.body.text, /10 分钟内有效/);
    assert.equal(f.callsTo('/rpc/svc_otp_release').length, 0);
  });

  test(`${label}：Resend 回 500 → 撤回那一笔，回 500`, async () => {
    const f = routes({ resend: () => jsonRes(500, { message: 'x' }) });
    const res = await run(signedRequest(payload(), NOW), f);
    assert.equal(res.status, 500);
    assert.deepEqual(f.callsTo('/rpc/svc_otp_release')[0].body, { p_id: 42 });
  });

  test(`${label}：Resend 一直没回应 → 超时、撤回、回 500`, async () => {
    const f = routes({ resend: hang });
    const t0 = Date.now();
    const res = await run(signedRequest(payload(), NOW), f, { resendTimeoutMs: 50 });
    assert.equal(res.status, 500);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(f.callsTo('/rpc/svc_otp_release')[0].body, { p_id: 42 });
  });

  test(`${label}：限流的 rpc 失败 → 不寄信，回 500`, async () => {
    const f = routes({ reserve: () => jsonRes(500, { message: 'db' }) });
    const res = await run(signedRequest(payload(), NOW), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('api.resend.com').length, 0);
  });

  test(`${label}：签名对但 body 不是 JSON → 500，不寄信`, async () => {
    const f = routes();
    const res = await run(signedRequest(null, NOW, { rawBody: 'not json' }), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('api.resend.com').length, 0);
  });

  test(`${label}：没有验证码 → 500，不寄信、不算次数`, async () => {
    const f = routes();
    const res = await run(signedRequest(payload({ token: '' }), NOW), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('api.resend.com').length, 0);
    assert.equal(f.callsTo('/rpc/').length, 0);
  });

  test(`${label}：撤回那一笔也失败 → 仍回 500`, async () => {
    const f = fakeFetch([
      ['/rpc/svc_otp_reserve', () => jsonRes(200, { ok: true, id: 7 })],
      ['/rpc/svc_otp_release', () => jsonRes(500, {})],
      ['api.resend.com', () => jsonRes(500, {})],
    ]);
    const res = await run(signedRequest(payload(), NOW), f);
    assert.equal(res.status, 500);
    assert.equal(f.callsTo('/rpc/svc_otp_release').length, 1);
  });

  test(`${label}：缺钩子 secret 或 Resend key → 500，不寄信`, async () => {
    for (const missing of ['SEND_EMAIL_HOOK_SECRET', 'RESEND_API_KEY']) {
      const f = routes();
      const env = (k) => (k === missing ? undefined : ENV(k));
      const res = await mod.handleSendEmail(signedRequest(payload(), NOW), { env, fetch: f, nowSec: () => NOW });
      assert.equal(res.status, 500, missing);
      assert.equal(f.callsTo('api.resend.com').length, 0, missing);
    }
  });

  test(`${label}：出错时的日志不含邮箱、验证码、key`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try {
      await run(signedRequest(payload(), NOW), routes({ resend: () => jsonRes(500, {}) }));
      await run(signedRequest(payload(), NOW), routes({ reserve: () => jsonRes(500, {}) }));
    } finally { console.error = orig; }
    assert.ok(logs.length >= 2, '应该有日志');
    for (const l of logs) assert.doesNotMatch(l, /me@x\.com|123456|re_test|sb_secret/);
  });

  test(`${label}：钩子 secret 贴错（太短）→ 401，日志写「设定」但不含内容`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    let res;
    try {
      const env = (k) => (k === 'SEND_EMAIL_HOOK_SECRET' ? 'v1,whsec_QUJD' : ENV(k));
      res = await mod.handleSendEmail(signedRequest(payload(), NOW), { env, fetch: routes(), nowSec: () => NOW });
    } finally { console.error = orig; }
    assert.equal(res.status, 401);
    assert.ok(logs.some((l) => /设定/.test(l)));
    for (const l of logs) assert.doesNotMatch(l, /QUJD/);
  });

  test(`${label}：信件内容只放验证码，HTML 不会被注入`, () => {
    assert.doesNotMatch(mod.emailHtml('<b>1</b>'), /<b>1<\/b>/);
    assert.match(mod.emailText('654321'), /654321/);
  });
}
