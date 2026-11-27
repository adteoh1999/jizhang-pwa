// 临时的测试图评估函数（ai-eval）：用服务器上的 key 跑跟 bot 一样的辨识＋检查；不碰资料库。评估完就从远端删掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBoth, fakeFetch, jsonRes } from './helpers/edge-fn.js';

const TOKEN = 'e'.repeat(64);
const AKEY = 'sk-ant-' + 'a'.repeat(40);
const ENV = { AI_EVAL_TOKEN: TOKEN, ANTHROPIC_API_KEY: AKEY };
const SOF0 = [0xff, 0xc0, 0, 11, 8, 0x09, 0xe4, 0x04, 0x92, 1, 1, 0x11, 0];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, ...SOF0, 0xff, 0xda, 0, 2, 1, 2, 0xff, 0xd9]);
const GOOD = { is_payment: true, kind: 'expense', currency: 'MYR', amount: '8.50', merchant: 'Kedai Kopi', category_id: 'food', date: '2026-11-27' };
const aiOk = (data = GOOD) => jsonRes(200, { model: 'claude-haiku-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 4000, output_tokens: 90 } });
const req = (body, token = TOKEN) => new Request('https://p.supabase.co/functions/v1/ai-eval', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Eval-Token': token } : {}) }, body: JSON.stringify(body) });
const B64 = Buffer.from(JPEG).toString('base64');

test('ai-eval 只 import _shared 的四个档，不碰资料库（没有 rpc、没有 SUPABASE 变数）', () => {
  const src = readFileSync(new URL('../supabase/functions/ai-eval/index.ts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../_shared/ai-extract.ts', '../_shared/bot-categories.ts', '../_shared/bot-extract.ts', '../_shared/telegram.ts']);
  assert.doesNotMatch(src, /rpc\(|SUPABASE_/);
});

for (const [label, mod] of await loadBoth('ai-eval')) {
  const run = async (body, f, { env = ENV, token } = {}) => {
    const res = await mod.handleAiEval(req(body, token === undefined ? TOKEN : token), { env: (k) => env[k], fetch: f });
    let json = null;
    try { json = await res.json(); } catch { /* 空 */ }
    return { status: res.status, json };
  };

  test(`${label}：没带／错 token → 401；token 没设或太短 → 500；都没叫 AI`, async () => {
    for (const [token, env, code] of [[null, ENV, 401], ['x'.repeat(64), ENV, 401], [TOKEN, { ...ENV, AI_EVAL_TOKEN: undefined }, 500], [TOKEN, { ...ENV, AI_EVAL_TOKEN: 'short' }, 500]]) {
      const f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
      const r = await run({ image: B64, today: '2026-11-27' }, f, { env, token: token ?? '' });
      assert.equal(r.status, code);
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：正常 → 回 AI 栏位、检查后的结果、用量；送 AI 的是去过拍摄资料的图、内建分类`, async () => {
    const f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
    const r = await run({ image: B64, today: '2026-11-27', caption: '' }, f);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.ai, GOOD);
    assert.deepEqual(r.json.check, { draft: { kind: 'expense', amountMinor: 850, categoryId: 'food', occurredOn: '2026-11-27', note: 'Kedai Kopi' } });
    assert.deepEqual(r.json.usage, { input_tokens: 4000, output_tokens: 90 });
    const sentBody = f.calls[0].body;
    assert.equal(sentBody.messages[0].content[0].source.data, B64);
    assert.match(sentBody.messages[0].content[1].text, /今天：2026-11-27/);
    assert.match(sentBody.messages[0].content[1].text, /"other_income"/);
  });

  test(`${label}：外币 → check 是 foreign；AI 失败 → 回 why；图坏掉 → image_bad、没叫 AI`, async () => {
    let f = fakeFetch([['api.anthropic.com', () => aiOk({ ...GOOD, currency: 'other' })]]);
    assert.deepEqual((await run({ image: B64, today: '2026-11-27' }, f)).json.check, { fail: 'foreign' });
    f = fakeFetch([['api.anthropic.com', () => jsonRes(400, { error: { type: 'invalid_request_error' } })]]);
    const r = await run({ image: B64, today: '2026-11-27' }, f);
    assert.deepEqual(r.json.ai_error, { why: 'http', status: 400, errType: 'invalid_request_error' });
    f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
    assert.deepEqual((await run({ image: Buffer.from([1, 2, 3]).toString('base64'), today: '2026-11-27' }, f)).json, { error: 'image_bad' });
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：今天不是 YYYY-MM-DD、图太大（base64 超过 8 MB）、不是 POST → 400／405、没叫 AI`, async () => {
    const f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
    assert.equal((await run({ image: B64, today: '27/11/2026' }, f)).status, 400);
    assert.equal((await run({ image: B64, today: '2026-13-40' }, f)).status, 400);   // 审核：不存在的日期也先挡
    assert.equal((await run({ image: 'A'.repeat(8 * 1024 * 1024 + 4), today: '2026-11-27' }, f)).status, 400);
    const g = await mod.handleAiEval(new Request('https://p/x', { method: 'GET' }), { env: (k) => ENV[k], fetch: f });
    assert.equal(g.status, 405);
    assert.equal(f.calls.length, 0);
  });
}

// 审核（ai-eval）：跟 bot 一致的补测
for (const [label, mod] of await loadBoth('ai-eval')) {
  const run = async (body, f) => {
    const res = await mod.handleAiEval(req(body), { env: (k) => ENV[k], fetch: f });
    return { status: res.status, json: await res.json() };
  };
  test(`${label}：审核：原始档超过 5 MB（bot 的上限）→ image_bad、没叫 AI`, async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(JPEG.slice(0, -2));
    big.set([0xff, 0xd9], big.length - 2);
    const f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
    assert.deepEqual((await run({ image: Buffer.from(big).toString('base64'), today: '2026-11-27' }, f)).json, { error: 'image_bad' });
    assert.equal(f.calls.length, 0);
  });
  test(`${label}：审核：说明文字跟 bot 一样先 trim（「 午餐 」→ 备注「午餐」）`, async () => {
    const f = fakeFetch([['api.anthropic.com', () => aiOk()]]);
    const r = await run({ image: B64, today: '2026-11-27', caption: '  午餐  ' }, f);
    assert.equal(r.json.check.draft.note, '午餐');
    assert.ok(f.calls[0].body.messages[0].content[1].text.endsWith(JSON.stringify('午餐')));
  });
  test(`${label}：审核：意外错误 → 500 固定字、不带错误内容`, async () => {
    const f = () => { throw Object.assign(new Error('秘密 sk-ant-xxx'), { name: 'Weird' }); };
    const r = await run({ image: B64, today: '2026-11-27' }, f);
    assert.ok(r.status === 200 || r.status === 500);
    assert.doesNotMatch(JSON.stringify(r.json), /秘密|sk-ant/);
    const envBoom = (k) => { if (k === 'ANTHROPIC_API_KEY') throw new Error('秘密'); return ENV[k]; };
    const res = await mod.handleAiEval(req({ image: B64, today: '2026-11-27' }), { env: envBoom, fetch: f });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'unexpected' });
  });
}
