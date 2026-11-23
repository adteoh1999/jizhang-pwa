import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyWebhook, webhookKeyOk } from '../supabase/functions/_shared/webhook.ts';

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

test('刚好 300 秒 → true（边界）', async () => {
  const ts = NOW - 300;
  assert.equal(await verifyWebhook(SECRET, headers(sign('msg_1', ts, BODY), ts), BODY, NOW), true);
});

test('secret 不带 v1,whsec_ 前缀也能用', async () => {
  assert.equal(await verifyWebhook(raw.toString('base64'), headers(sign('msg_1', NOW, BODY)), BODY, NOW), true);
});

test('时间戳不是数字 → false', async () => {
  const h = headers(sign('msg_1', NOW, BODY));
  h.set('webhook-timestamp', '17e8');
  assert.equal(await verifyWebhook(SECRET, h, BODY, NOW), false);
});

test('多个签名里夹一个坏 base64，后面那个对 → true', async () => {
  assert.equal(await verifyWebhook(SECRET, headers(`v1,@@@ ${sign('msg_1', NOW, BODY)}`), BODY, NOW), true);
});

test('secret 太短（贴错只剩前缀）→ false', async () => {
  assert.equal(await verifyWebhook('v1,whsec_', headers(sign('msg_1', NOW, BODY, Buffer.alloc(0))), BODY, NOW), false);
  const short = randomBytes(8);
  assert.equal(await verifyWebhook('v1,whsec_' + short.toString('base64'), headers(sign('msg_1', NOW, BODY, short)), BODY, NOW), false);
});

test('webhookKeyOk：secret 格式检查（给日志用）', () => {
  assert.equal(webhookKeyOk(SECRET), true);
  assert.equal(webhookKeyOk('v1,whsec_'), false);
  assert.equal(webhookKeyOk('v1,whsec_@@@'), false);
  assert.equal(webhookKeyOk('v1,whsec_' + randomBytes(8).toString('base64')), false);
});
