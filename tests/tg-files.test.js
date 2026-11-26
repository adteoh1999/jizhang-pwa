// 3d Task 5：Telegram 回传结果、webhook 密钥比对、挑照片、下载档案、认图片、base64
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tgBotCallResult, tgSecretOk, tgSecretEqual, tgPickPhoto, tgImageDoc, tgDownload, tgSniffImage, tgBase64,
} from '../supabase/functions/_shared/telegram.ts';
import { fakeFetch, jsonRes, hang } from './helpers/edge-fn.js';

// 全是假的测试资料
const TOKEN = '123456:' + 'F'.repeat(35);
const MB = 1024 * 1024;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]);

// 注意：fakeFetch 用 includes 比对，/file/bot 要排在 /bot 前面
const routes = ({ file = () => new Response(JPEG), getFile = () => jsonRes(200, { ok: true, result: { file_path: 'photos/file_1.jpg' } }) } = {}) =>
  fakeFetch([['/file/bot', file], ['/getFile', getFile]]);

test('tgBotCallResult：成功回 result；失败回 status；不 throw', async () => {
  let f = fakeFetch([['/getMe', () => jsonRes(200, { ok: true, result: { id: 1 } })]]);
  assert.deepEqual(await tgBotCallResult(f, TOKEN, 'getMe', {}, 1000), { ok: true, result: { id: 1 } });
  f = fakeFetch([['/getMe', () => jsonRes(400, { ok: false, description: 'x' })]]);
  assert.deepEqual(await tgBotCallResult(f, TOKEN, 'getMe', {}, 1000), { ok: false, status: 400 });
  f = fakeFetch([['/getMe', () => { throw new Error('boom ' + TOKEN); }]]);
  assert.deepEqual(await tgBotCallResult(f, TOKEN, 'getMe', {}, 1000), { ok: false, status: 0 });
  assert.deepEqual(await tgBotCallResult(f, 'bad', 'getMe', {}, 1000), { ok: false, status: 0 });
});

test('tgSecretOk：32–256 字、只能英数 _ -', () => {
  assert.equal(tgSecretOk('a'.repeat(32)), true);
  assert.equal(tgSecretOk('A_-9'.repeat(64)), true);
  for (const s of [undefined, '', 'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(31) + '!', 'a'.repeat(32) + ' ']) {
    assert.equal(tgSecretOk(s), false, String(s));
  }
});

test('tgSecretEqual：相等 true；差一字、长度不同、空字串、非字串 false', async () => {
  const s = 'x'.repeat(40);
  assert.equal(await tgSecretEqual(s, s), true);
  assert.equal(await tgSecretEqual(s, 'x'.repeat(39) + 'y'), false);
  assert.equal(await tgSecretEqual(s, s + 'x'), false);
  assert.equal(await tgSecretEqual(s, ''), false);
  assert.equal(await tgSecretEqual('', ''), false);
  assert.equal(await tgSecretEqual(s, null), false);
  assert.equal(await tgSecretEqual(undefined, s), false);
});

test('tgPickPhoto：挑长边 ≤ 2576、≤ 5 MB 里面积最大的，不靠阵列顺序', () => {
  const sizes = [
    { file_id: 'big', width: 2560, height: 1280, file_size: 400000 },
    { file_id: 'small', width: 90, height: 45, file_size: 1000 },
    { file_id: 'huge', width: 4000, height: 3000, file_size: 900000 },
    { file_id: 'mid', width: 1280, height: 640 },
  ];
  assert.deepEqual(tgPickPhoto(sizes), { fileId: 'big' });
});

test('tgPickPhoto：file_size 没写也可以；全部太大或不是阵列 → null', () => {
  assert.deepEqual(tgPickPhoto([{ file_id: 'a', width: 800, height: 600 }]), { fileId: 'a' });
  assert.equal(tgPickPhoto([{ file_id: 'a', width: 3000, height: 600 }, { file_id: 'b', width: 800, height: 600, file_size: 6 * MB }]), null);
  assert.equal(tgPickPhoto(null), null);
  assert.equal(tgPickPhoto([{ file_id: 5, width: 1, height: 1 }, { width: 1, height: 1 }]), null);
});

test('tgImageDoc：jpeg／png／webp、≤ 5 MB 或没写大小；其他 null', () => {
  assert.deepEqual(tgImageDoc({ file_id: 'd', mime_type: 'image/png', file_size: 1000 }), { fileId: 'd' });
  assert.deepEqual(tgImageDoc({ file_id: 'd', mime_type: 'image/jpeg' }), { fileId: 'd' });
  assert.equal(tgImageDoc({ file_id: 'd', mime_type: 'application/pdf' }), null);
  assert.equal(tgImageDoc({ file_id: 'd', mime_type: 'image/gif' }), null);
  assert.equal(tgImageDoc({ file_id: 'd', mime_type: 'image/png', file_size: 6 * MB }), null);
  assert.equal(tgImageDoc(null), null);
});

test('tgDownload：getFile → 下载（redirect error、网址正确）→ 回位元组', async () => {
  const f = routes();
  const r = await tgDownload(f, TOKEN, 'AgAC-file_ID', 5 * MB, 2000);
  assert.deepEqual([...r], [...JPEG]);
  assert.deepEqual(f.callsTo('/getFile')[0].body, { file_id: 'AgAC-file_ID' });
  const dl = f.callsTo('/file/bot')[0];
  assert.equal(dl.url, `https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);
  assert.equal(dl.init.redirect, 'error');
});

test('tgDownload：file_path 有 .. 或怪字元、没有 file_path、getFile 失败 → null、不下载', async () => {
  for (const fp of ['../x.jpg', 'a/../b', 'photos/a b.jpg', 'photos/a?x=1', '', undefined]) {
    const f = routes({ getFile: () => jsonRes(200, { ok: true, result: { file_path: fp } }) });
    assert.equal(await tgDownload(f, TOKEN, 'id', 5 * MB, 2000), null, String(fp));
    assert.equal(f.callsTo('/file/bot').length, 0);
  }
  const f = routes({ getFile: () => jsonRes(400, { ok: false }) });
  assert.equal(await tgDownload(f, TOKEN, 'id', 5 * MB, 2000), null);
});

test('tgDownload：file_id 不合格不叫 Telegram', async () => {
  const f = routes();
  assert.equal(await tgDownload(f, TOKEN, 'a/b', 5 * MB, 2000), null);
  assert.equal(await tgDownload(f, TOKEN, '', 5 * MB, 2000), null);
  assert.equal(f.calls.length, 0);
});

test('tgDownload：超过上限就中止 → null', async () => {
  const f = routes({ file: () => new Response(new Uint8Array(2000)) });
  assert.equal(await tgDownload(f, TOKEN, 'id', 1000, 2000), null);
});

test('tgDownload：下载 HTTP 错误、连线错误、逾时 → null（不 throw）', async () => {
  assert.equal(await tgDownload(routes({ file: () => new Response('x', { status: 404 }) }), TOKEN, 'id', 1000, 2000), null);
  assert.equal(await tgDownload(routes({ file: () => { throw new Error('boom ' + TOKEN); } }), TOKEN, 'id', 1000, 2000), null);
  assert.equal(await tgDownload(routes({ file: hang }), TOKEN, 'id', 1000, 50), null);
});

test('tgSniffImage：看档头', () => {
  assert.equal(tgSniffImage(JPEG), 'image/jpeg');
  assert.equal(tgSniffImage(PNG), 'image/png');
  assert.equal(tgSniffImage(WEBP), 'image/webp');
  assert.equal(tgSniffImage(GIF), null);
  assert.equal(tgSniffImage(new Uint8Array([1, 2, 3])), null);
  assert.equal(tgSniffImage(new Uint8Array(0)), null);
});

test('tgBase64：与 Buffer 相同（0、32766、32767、100000 bytes）', () => {
  for (const n of [0, 1, 2, 32766, 32767, 100000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
    assert.equal(tgBase64(b), Buffer.from(b).toString('base64'), String(n));
  }
});

test('tgBase64：5 MB 在 200 毫秒内', () => {
  const b = new Uint8Array(5 * MB).map((_, i) => i & 255);
  const t = performance.now();
  tgBase64(b);
  assert.ok(performance.now() - t < 200, `花了 ${Math.round(performance.now() - t)} 毫秒`);
});

// ---------- 审核（Task 2–6）补测 ----------
test('审核：content-length 先就超过上限 → 不读内容、回 null', async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(10)); } });
  const f = routes({ file: () => new Response(body, { headers: { 'content-length': '2000' } }) });
  assert.equal(await tgDownload(f, TOKEN, 'id', 1000, 2000), null);
  assert.ok(pulled <= 1, `读了 ${pulled} 块`);
});
test('审核：没有 content-length、分块超过上限 → 中止（cancel 被叫到）、后面的块没读', async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) { pulled += 1; c.enqueue(new Uint8Array(400)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const f = routes({ file: () => new Response(body) });
  assert.equal(await tgDownload(f, TOKEN, 'id', 1000, 2000), null);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 4, `读了 ${pulled} 块`);
});
test('审核：getFile 卡住 → 预算内回 null；getFile 用掉时间后下载只剩下余下的预算', async () => {
  let f = routes({ getFile: hang });
  let t = Date.now();
  assert.equal(await tgDownload(f, TOKEN, 'id', 1000, 80), null);
  assert.ok(Date.now() - t < 1000);
  f = routes({ getFile: () => new Promise((ok) => setTimeout(() => ok(jsonRes(200, { ok: true, result: { file_path: 'a.jpg' } })), 60)), file: hang });
  t = Date.now();
  assert.equal(await tgDownload(f, TOKEN, 'id', 1000, 120), null);
  assert.ok(Date.now() - t < 1000);
});
test('审核：宽高是 Infinity／NaN 的尺寸不选', () => {
  assert.equal(tgPickPhoto([{ file_id: 'a', width: Infinity, height: 10 }, { file_id: 'b', width: NaN, height: 10 }]), null);
});
