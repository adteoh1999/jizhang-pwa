import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyWebhook } from '../supabase/functions/_shared/webhook.ts';

// 测试自己产生的 secret（不是真的）
const raw = randomBytes(32);
const SECRET = 'v1,whsec_' + raw.toString('base64');
const NOW = 1_800_000_000;
const BODY = '{"user":{"email":"a@x.com"},"email_data":{"token":"123456"}}';

function sign(id, ts, body, key = raw) {
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}
function headers(sig, ts = NOW, id = 'msg_1') {
  const h = new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts) });
  if (sig !== null) h.set('webhook-signature', sig);
  return h;
}

test('签名正确 → true', async () => {
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', NOW, BODY)), BODY, NOW), true);
});

test('body 改一个字 → false', async () => {
  const sig = sign('msg_1', NOW, BODY);
  assert.equal(await verifyWebhook(SECRET, headers(sig), BODY.replace('123456', '123457'), NOW), false);
});

test('时间早了 301 秒 → false', async () => {
  const ts = NOW - 301;
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', ts, BODY), ts), BODY, NOW), false);
});

test('时间晚了 301 秒（未来）→ false', async () => {
  const ts = NOW + 301;
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', ts, BODY), ts), BODY, NOW), false);
});

test('时间差 300 秒内 → true', async () => {
  const ts = NOW - 299;
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', ts, BODY), ts), BODY, NOW), true);
});

test('有多个签名，第二个才对 → true', async () => {
  const bad = sign('msg_1', NOW, BODY, randomBytes(32));
  const good = sign('msg_1', NOW, BODY);
  assert.equal(await verifyWebhook(SECRET, headers(`${bad} ${good}`), BODY, NOW), true);
});

test('缺 webhook-signature → false', async () => {
  assert.equal(await verifyWebhook(SECRET, headers(null), BODY, NOW), false);
});

test('用别的 key 签 → false', async () => {
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', NOW, BODY, randomBytes(32))), BODY, NOW), false);
});

test('webhook-id 不同 → false', async () => {
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', NOW, BODY), NOW, 'msg_2'), BODY, NOW), false);
});

test('secret 不是 base64 也不会当掉 → false', async () => {
  assert.equal(await verifyWebhook('v1,whsec_@@@', headers(sign('msg_1', NOW, BODY)), BODY, NOW), false);
});
