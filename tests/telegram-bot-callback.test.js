// 3d Task 8：telegram-bot 按钮流程（原始档与打包档都跑；网络全是假的）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes } from './helpers/edge-fn.js';
import * as R from '../supabase/functions/_shared/bot-reply.ts';

const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const BOT = '123456:' + 'C'.repeat(35);
const SECRET = 'T'.repeat(40);
const ENV_OBJ = {
  SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}`, TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_WEBHOOK_SECRET: SECRET, ANTHROPIC_API_KEY: 'sk-ant-' + 'a'.repeat(40),
};
const TID = 5000000888;
const TX = '0b6f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const PEND = '1c7a4b63-2d3e-4f50-9b1c-1d2e3f4a5b6c';
const NOW = Date.UTC(2026, 10, 26, 4, 0, 0);
const TODAY = '2026-11-26';
const tx = (over = {}) => ({ id: TX, kind: 'expense', amount_minor: 690, category_id: 'food', occurred_on: TODAY, note: '早餐', deleted: false, ...over });

const cbUpdate = (data, { msg = {}, from = {} } = {}) => ({
  update_id: 7001,
  callback_query: {
    id: 'cbq-1', from: { id: TID, is_bot: false, first_name: 'Z', ...from }, chat_instance: 'x', data,
    message: { message_id: 55, date: 1764000000, chat: { id: TID, type: 'private' }, ...msg },
  },
});

function routes(o = {}) {
  const rpc = (name, def) => [`/rpc/${name}`, o[name] ?? def];
  return fakeFetch([
    rpc('svc_bot_ai_consent', () => jsonRes(200, true)),
    rpc('svc_bot_undo', () => jsonRes(200, { status: 'done', tx: tx({ deleted: true }) })),
    rpc('svc_bot_tx', () => jsonRes(200, tx())),
    rpc('svc_bot_categories', () => jsonRes(200, [])),
    rpc('svc_bot_set_category', (u, i, b) => jsonRes(200, { status: 'done', tx: tx({ category_id: b.p_category_id, kind: b.p_kind }) })),
    rpc('svc_bot_confirm', () => jsonRes(200, { status: 'recorded', tx: tx({ id: PEND }) })),
    rpc('svc_bot_discard', () => jsonRes(200, true)),
    ['/answerCallbackQuery', o.answer ?? (() => jsonRes(200, { ok: true, result: true }))],
    ['/editMessageText', o.editText ?? (() => jsonRes(200, { ok: true, result: {} }))],
    ['/editMessageReplyMarkup', o.editMarkup ?? (() => jsonRes(200, { ok: true, result: {} }))],
  ]);
}

const req = (body) => new Request(`${BASE}/functions/v1/telegram-bot`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(body),
});

async function quiet(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return { r: await fn(), logs }; } finally { Object.assign(console, orig); }
}

const answers = (f) => f.callsTo('/answerCallbackQuery').map((c) => c.body);
const edits = (f) => f.callsTo('/editMessageText').map((c) => c.body);
const markups = (f) => f.callsTo('/editMessageReplyMarkup').map((c) => c.body);
const rpcBody = (f, n) => f.callsTo(`/rpc/${n}`).map((c) => c.body);

for (const [label, mod] of await loadBoth('telegram-bot')) {
  const run = async (body, f) => {
    const { r: res, logs } = await quiet(() => mod.handleTelegramBot(req(body), { env: (k) => ENV_OBJ[k], fetch: f, nowMs: () => NOW }));
    for (const l of logs) for (const s of [BOT, String(TID), '早餐']) assert.ok(!l.includes(s), `日志出现 ${s}`);
    // 每条路都要 answerCallbackQuery，而且只一次
    assert.equal(answers(f).length, 1, '要回 answerCallbackQuery 一次');
    assert.equal(answers(f)[0].callback_query_id, 'cbq-1');
    return res.status;
  };

  test(`${label}：同意 AI → 讯息改成「已同意」、没有按钮`, async () => {
    const f = routes();
    assert.equal(await run(cbUpdate('a:1'), f), 200);
    assert.deepEqual(rpcBody(f, 'svc_bot_ai_consent'), [{ p_telegram_id: TID }]);
    assert.equal(edits(f)[0].text, R.BOT_CONSENT_OK);
    assert.equal(edits(f)[0].chat_id, TID);
    assert.equal(edits(f)[0].message_id, 55);
    assert.equal(edits(f)[0].reply_markup, undefined);
  });

  test(`${label}：同意但连接已不在 → 过期`, async () => {
    const f = routes({ svc_bot_ai_consent: () => jsonRes(200, false) });
    await run(cbUpdate('a:1'), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED);
    assert.equal(edits(f).length, 0);
  });

  test(`${label}：撤销成功 → 讯息改成「已撤销」、拿掉按钮`, async () => {
    const f = routes();
    await run(cbUpdate(`u:${TX}`), f);
    assert.deepEqual(rpcBody(f, 'svc_bot_undo'), [{ p_telegram_id: TID, p_tx_id: TX }]);
    assert.equal(edits(f)[0].text, '↩️ 已撤销：餐饮 RM 6.90（早餐）');
    assert.equal(edits(f)[0].reply_markup, undefined);
  });

  test(`${label}：撤销：already → 已删除；not_found → 过期；busy → 现在记不了（绝不说已撤销）`, async () => {
    for (const [status, ans] of [['already', R.BOT_ANS_DELETED], ['not_found', R.BOT_ANS_EXPIRED], ['busy', R.BOT_DOWN]]) {
      const f = routes({ svc_bot_undo: () => jsonRes(200, { status }) });
      await run(cbUpdate(`u:${TX}`), f);
      assert.equal(answers(f)[0].text, ans, status);
      assert.equal(edits(f).length, 0);
    }
  });

  test(`${label}：编辑讯息失败（太旧）→ 账已改好，改用短字`, async () => {
    const f = routes({ editText: () => jsonRes(400, { ok: false }) });
    await run(cbUpdate(`u:${TX}`, { msg: { date: 0 } }), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_UNDONE);
  });

  test(`${label}：改分类 → 换成分类选单（只换按钮，提示用短字）`, async () => {
    const f = routes();
    await run(cbUpdate(`c:${TX}`), f);
    const kb = (await R.botCategoryKeyboard(TX, [
      { id: 'food', name: '餐饮' }, { id: 'transport', name: '交通' }, { id: 'shopping', name: '购物' }, { id: 'bills', name: '账单' },
      { id: 'fun', name: '娱乐' }, { id: 'other', name: '其他' }, { id: 'salary', name: '工资' }, { id: 'bonus', name: '奖金' },
      { id: 'side', name: '副业' }, { id: 'other_income', name: '其他收入' }])).markup;
    assert.deepEqual(markups(f)[0].reply_markup, kb);
    assert.equal(answers(f)[0].text, R.botCategoryPrompt(false));
  });

  test(`${label}：改分类：这笔找不到 → 过期；已删除 → 已删除`, async () => {
    let f = routes({ svc_bot_tx: () => jsonRes(200, null) });
    await run(cbUpdate(`c:${TX}`), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED);
    f = routes({ svc_bot_tx: () => jsonRes(200, tx({ deleted: true })) });
    await run(cbUpdate(`c:${TX}`), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_DELETED);
    assert.equal(markups(f).length, 0);
  });

  test(`${label}：选分类（收入分类）→ set_category 的 kind 跟着变、讯息改回「已记」＋原按钮`, async () => {
    const f = routes();
    const h = await R.botCatHash('salary');
    await run(cbUpdate(`s:${TX}:6:${h}`), f);
    assert.deepEqual(rpcBody(f, 'svc_bot_set_category'), [{ p_telegram_id: TID, p_tx_id: TX, p_category_id: 'salary', p_kind: 'income' }]);
    assert.equal(edits(f)[0].text, '✅ 已记：工资 RM 6.90（早餐）');
    assert.deepEqual(edits(f)[0].reply_markup, R.botRecordedKeyboard(TX));
  });

  test(`${label}：选分类：序号超出、hash 对不上（清单变了）→ 分类有变动、没改账`, async () => {
    for (const data of [`s:${TX}:12:${await R.botCatHash('food')}`, `s:${TX}:0:${await R.botCatHash('salary')}`]) {
      const f = routes();
      await run(cbUpdate(data), f);
      assert.equal(answers(f)[0].text, R.BOT_ANS_CAT_CHANGED);
      assert.equal(rpcBody(f, 'svc_bot_set_category').length, 0);
    }
  });

  test(`${label}：选分类：deleted → 已删除；busy → 现在记不了；not_found → 过期`, async () => {
    const h = await R.botCatHash('food');
    for (const [status, ans] of [['deleted', R.BOT_ANS_DELETED], ['busy', R.BOT_DOWN], ['not_found', R.BOT_ANS_EXPIRED]]) {
      const f = routes({ svc_bot_set_category: () => jsonRes(200, { status }) });
      await run(cbUpdate(`s:${TX}:0:${h}`), f);
      assert.equal(answers(f)[0].text, ans, status);
      assert.equal(edits(f).length, 0);
    }
  });

  test(`${label}：取消选分类 → 按钮换回原本的`, async () => {
    const f = routes();
    await run(cbUpdate(`b:${TX}`), f);
    assert.deepEqual(markups(f)[0].reply_markup, R.botRecordedKeyboard(TX));
  });

  test(`${label}：还要记 → confirm → 讯息改成「已记」＋按钮（账 id = pending id）`, async () => {
    const f = routes();
    await run(cbUpdate(`y:${PEND}`), f);
    assert.deepEqual(rpcBody(f, 'svc_bot_confirm'), [{ p_telegram_id: TID, p_pending_id: PEND }]);
    assert.equal(edits(f)[0].text, '✅ 已记：餐饮 RM 6.90（早餐）');
    assert.deepEqual(edits(f)[0].reply_markup, R.botRecordedKeyboard(PEND));
  });

  test(`${label}：还要记：gone → 过期；按两次但账已在 App 删掉 → 已删除，不说已记`, async () => {
    let f = routes({ svc_bot_confirm: () => jsonRes(200, { status: 'gone' }) });
    await run(cbUpdate(`y:${PEND}`), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED);
    f = routes({ svc_bot_confirm: () => jsonRes(200, { status: 'recorded', tx: tx({ id: PEND, deleted: true }) }) });
    await run(cbUpdate(`y:${PEND}`), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_DELETED);
    assert.equal(edits(f).length, 0);
  });

  test(`${label}：不用 → discard → 讯息改成「好，这笔不记」；已经不在 → 过期`, async () => {
    let f = routes();
    await run(cbUpdate(`n:${PEND}`), f);
    assert.equal(edits(f)[0].text, R.BOT_SKIPPED);
    assert.equal(edits(f)[0].reply_markup, undefined);
    f = routes({ svc_bot_discard: () => jsonRes(200, false) });
    await run(cbUpdate(`n:${PEND}`), f);
    assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED);
  });

  test(`${label}：伪造或坏掉的按钮资料 → 过期、没叫任何 rpc`, async () => {
    for (const data of ['x', `u:${TX.toUpperCase()}`, `s:${TX}:99:zzzzzzzz`, undefined, 'a:2']) {
      const f = routes();
      await run(cbUpdate(data), f);
      assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED, String(data));
      assert.equal(f.calls.filter((c) => c.url.includes('/rpc/')).length, 0);
    }
  });

  test(`${label}：按钮讯息不是私聊、chat.id ≠ from.id、没有 message、按的人是 bot → 只 answer`, async () => {
    for (const opt of [{ msg: { chat: { id: -100, type: 'group' } } }, { msg: { chat: { id: 1, type: 'private' } } }, { from: { is_bot: true } }]) {
      const f = routes();
      await run(cbUpdate(`u:${TX}`, opt), f);
      assert.equal(f.calls.filter((c) => c.url.includes('/rpc/')).length, 0);
    }
    const f = routes();
    const u = cbUpdate(`u:${TX}`);
    delete u.callback_query.message;
    await run(u, f);
    assert.equal(f.calls.filter((c) => c.url.includes('/rpc/')).length, 0);
  });

  test(`${label}：rpc 失败 → answer 现在记不了、200`, async () => {
    const f = routes({ svc_bot_undo: () => jsonRes(500, {}) });
    assert.equal(await run(cbUpdate(`u:${TX}`), f), 200);
    assert.equal(answers(f)[0].text, R.BOT_DOWN);
  });
}


// ======================= 审核（Task 7–8）补测 =======================
for (const [label, mod] of await loadBoth('telegram-bot')) {
  const go = async (body, f) => {
    const { r: res } = await quiet(() => mod.handleTelegramBot(req(body), { env: (k) => ENV_OBJ[k], fetch: f, nowMs: () => NOW }));
    return res.status;
  };

  test(`${label}：审核 M1：撤销成功但读分类失败 → 仍说已撤销（绝不说现在记不了）`, async () => {
    const f = routes({ svc_bot_categories: () => jsonRes(500, {}) });
    await go(cbUpdate(`u:${TX}`), f);
    const a = answers(f);
    assert.equal(a.length, 1);
    assert.notEqual(a[0].text, R.BOT_DOWN);
    assert.ok(edits(f).length === 1 ? (a[0].text ?? '') === '' : a[0].text === R.BOT_ANS_UNDONE);
  });

  test(`${label}：审核 M1：还要记成功但读分类失败 → 仍说已记（绝不说现在记不了）`, async () => {
    const f = routes({ svc_bot_categories: () => jsonRes(500, {}) });
    await go(cbUpdate(`y:${PEND}`), f);
    const a = answers(f);
    assert.notEqual(a[0].text, R.BOT_DOWN);
  });

  test(`${label}：审核：编辑失败改用短字（选分类、还要记、同意、不用）`, async () => {
    const h = await R.botCatHash('salary');
    for (const [data, want] of [[`s:${TX}:6:${h}`, '已改成 工资'], [`y:${PEND}`, R.BOT_ANS_RECORDED], ['a:1', R.BOT_CONSENT_OK], [`n:${PEND}`, R.BOT_SKIPPED]]) {
      const f = routes({ editText: () => jsonRes(400, { ok: false }) });
      await go(cbUpdate(data), f);
      assert.equal(answers(f)[0].text, want, data);
    }
  });

  test(`${label}：审核：超过 30 个分类 → 提示加一句；c／s 读到分类 null → 过期`, async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ id: 'c' + i, kind: 'expense', name: 'N' + i, sort: 100 + i, deleted: false }));
    let f = routes({ svc_bot_categories: () => jsonRes(200, many) });
    await go(cbUpdate(`c:${TX}`), f);
    assert.equal(answers(f)[0].text, R.botCategoryPrompt(true));
    for (const data of [`c:${TX}`, `s:${TX}:0:${await R.botCatHash('food')}`]) {
      f = routes({ svc_bot_categories: () => jsonRes(200, null) });
      await go(cbUpdate(data), f);
      assert.equal(answers(f)[0].text, R.BOT_ANS_EXPIRED, data);
    }
  });

  test(`${label}：审核：callback 没有 id → 200、不 answer；answer 自己失败仍 200`, async () => {
    let f = routes();
    const u = cbUpdate(`u:${TX}`);
    delete u.callback_query.id;
    assert.equal(await go(u, f), 200);
    assert.equal(answers(f).length, 0);
    f = routes({ answer: () => jsonRes(400, { ok: false }) });
    assert.equal(await go(cbUpdate(`u:${TX}`), f), 200);
  });
}
