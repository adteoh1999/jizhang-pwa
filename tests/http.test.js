import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, secretKey, rpc, adminHeaders } from '../supabase/functions/_shared/http.ts';

const envOf = (o) => (k) => o[k];

test('json：状态码、内容、content-type', async () => {
  const r = json(429, { a: 1 });
  assert.equal(r.status, 429);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await r.json(), { a: 1 });
});

test('secretKey：新版 SUPABASE_SECRET_KEYS 取 default', () => {
  assert.equal(secretKey(envOf({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' })), 'sb_secret_x');
});

test('secretKey：没有 default 就取第一个', () => {
  assert.equal(secretKey(envOf({ SUPABASE_SECRET_KEYS: '{"other":"sb_secret_y"}' })), 'sb_secret_y');
});

test('secretKey：只有旧变数 → 用旧的', () => {
  assert.equal(secretKey(envOf({ SUPABASE_SERVICE_ROLE_KEY: 'old' })), 'old');
});

test('secretKey：新变数坏掉 → 退回旧的', () => {
  assert.equal(secretKey(envOf({ SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: 'old' })), 'old');
});

test('secretKey：都没有 → throw', () => {
  assert.throws(() => secretKey(envOf({})));
});

test('adminHeaders：带 apikey', () => {
  assert.equal(adminHeaders('k').apikey, 'k');
});

function recorder(respond) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  return { f, calls };
}

test('rpc：网址、header、body 正确，回传 JSON', async () => {
  const { f, calls } = recorder(() => new Response('{"ok":true}', { status: 200 }));
  const out = await rpc(f, 'https://p.supabase.co', 'K', 'svc_otp_reserve', { p_email: 'a@x.com' });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/rpc/svc_otp_reserve');
  assert.equal(calls[0].init.method, 'POST');
  const h = new Headers(calls[0].init.headers);
  assert.equal(h.get('apikey'), 'K');
  assert.equal(h.get('content-profile'), 'svc');
  assert.match(h.get('content-type'), /application\/json/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_email: 'a@x.com' });
});

test('rpc：回传空内容（void 函数）→ null', async () => {
  const { f } = recorder(() => new Response(null, { status: 204 }));
  assert.equal(await rpc(f, 'https://p', 'K', 'svc_otp_release', { p_id: 1 }), null);
});

test('rpc：非 2xx → throw', async () => {
  const { f } = recorder(() => new Response('{"message":"x"}', { status: 500 }));
  await assert.rejects(rpc(f, 'https://p', 'K', 'x', {}));
});

test('rpc：超时 → throw（假 fetch 等到被中断才失败）', async () => {
  const f = (url, init) => new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('测试：超时没有触发')), 5000);  // 撑住事件循环
    init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  const t0 = Date.now();
  await assert.rejects(rpc(f, 'https://p', 'K', 'x', {}, 50));
  assert.ok(Date.now() - t0 < 1000);
});
