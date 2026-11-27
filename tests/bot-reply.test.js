// 3d Task 6：bot 的固定文案、回复组字、按钮资料
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../supabase/functions/_shared/bot-reply.ts';
import { formatRM } from '../js/money.js';
import { SHARED_IMPORT_FORBIDDEN } from '../scripts/build-functions.mjs';

const TX = '0b6f3a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const TODAY = '2026-11-26';
const bytes = (s) => new TextEncoder().encode(s).length;

test('_shared/bot-reply.ts 不 import 别的档（打包规则）', () => {
  const src = readFileSync(new URL('../supabase/functions/_shared/bot-reply.ts', import.meta.url), 'utf8');
  assert.equal(SHARED_IMPORT_FORBIDDEN.test(src), false);
});

test('固定文案逐字（用户已同意）', () => {
  assert.equal(R.BOT_NOT_UNDERSTOOD, '没看懂这笔帐，请传付款截图，或打像『午餐 12.50』这样的文字');
  assert.equal(R.BOT_FOREIGN, '目前只支援 RM，这笔请手动记');
  assert.equal(R.BOT_QUOTA, 'AI 记账次数用完了（每人 24 小时内 30 次），请晚点再试，或打开 App 手动记。');
  assert.equal(R.BOT_DOWN, '现在记不了，请稍后再试，或打开 App 手动记。');
  assert.equal(R.BOT_IMAGE_BAD, '这张图片读不了，请传截图（JPG／PNG，5 MB 以内）。');
  assert.equal(R.BOT_UNLINKED_START, '请先点下方按钮打开记账、用邮箱登录。');
  assert.equal(R.BOT_SKIPPED, '好，这笔不记。');
  // 用户 2026-11-27：不出现 Claude／Anthropic，统一说「AI 服务商」；文字尽量简短（只给身边朋友用）
  assert.equal(R.BOT_HELP,
    '传付款截图，或打「午餐 12.50」「昨天 晚餐 15」「工资 3000」，就会自动记一笔。记错了按［改分类］或［撤销］；改讯息不会改账，请按［改分类］或到 App 改。没有回应就再传一次。\n'
    + '截图、文字和分类名称会交给 AI 服务商自动识别，服务商一般最多保存 30 天；我们不存截图。目前只支援 RM。');
  assert.equal(R.BOT_CONSENT,
    '第一次用 AI 记账前请先看：你传的截图、文字和分类名称，会交给 AI 服务商自动识别金额和分类，服务商一般最多保存 30 天。'
    + '我们这里不存截图；截图只留在你和 bot 的聊天记录里，可以自己删。\n同意后，请再传一次这笔。');
  assert.equal(R.BOT_CONSENT_OK, '✅ 已同意。现在可以传付款截图，或打「午餐 12.50」记账了。');
  assert.equal(R.BOT_ANS_EXPIRED, '这个按钮已经过期了。');
  assert.equal(R.BOT_ANS_DELETED, '这笔已经删除了。');
  assert.equal(R.BOT_ANS_CAT_CHANGED, '分类有变动，请重新按［改分类］。');
  assert.equal(R.BOT_ANS_UNDONE, '已撤销');
  assert.equal(R.BOT_ANS_RECORDED, '已记好');
  assert.equal(R.botAnsCategory('购物'), '已改成 购物');
});

test('文案长度在 Telegram 上限内（讯息 4096、按钮回应 200）', () => {
  for (const s of [R.BOT_HELP, R.BOT_CONSENT]) assert.ok([...s].length <= 4096);
  for (const s of [R.BOT_ANS_EXPIRED, R.BOT_ANS_DELETED, R.BOT_ANS_CAT_CHANGED, R.BOT_DOWN]) assert.ok([...s].length <= 200);
});

test('botFormatRM 与 App 的 formatRM 相同', () => {
  for (const m of [1, 5, 690, 1250, 100000, 300050, 123456789, 9999999999]) assert.equal(R.botFormatRM(m), formatRM(m), String(m));
});

test('已记：今天、有备注', () => {
  assert.equal(R.botRecordedText({ kind: 'expense', amountMinor: 690, categoryName: '餐饮', note: '早餐', occurredOn: TODAY, today: TODAY }),
    '✅ 已记：餐饮 RM 6.90（早餐）');
});
test('已记：没备注不加括号；不是今天加日期', () => {
  assert.equal(R.botRecordedText({ kind: 'income', amountMinor: 300000, categoryName: '工资', note: '', occurredOn: '2026-11-05', today: TODAY }),
    '✅ 已记收入：工资 +RM 3,000.00 · 11月5日');   // 用户 2026-11-27：收入标明「收入」＋「+」
});
test('已记：备注超过 30 字截断加 …', () => {
  const t = R.botRecordedText({ kind: 'expense', amountMinor: 100, categoryName: '其他', note: '字'.repeat(40), occurredOn: TODAY, today: TODAY });
  assert.equal(t, `✅ 已记：其他 RM 1.00（${'字'.repeat(30)}…）`);
});
test('已撤销', () => {
  assert.equal(R.botUndoneText({ amountMinor: 690, categoryName: '餐饮', note: '早餐', occurredOn: '2026-11-25', today: TODAY }),
    '↩️ 已撤销：餐饮 RM 6.90（早餐） · 11月25日');
});
test('相似：今天／别天／已经找不到那笔', () => {
  assert.equal(R.botSimilarText({ amount_minor: 690, note: '早餐', occurred_on: TODAY }, '餐饮', TODAY),
    '今天已经有一笔差不多的：餐饮 RM 6.90（早餐）。还要记这一笔吗？');
  assert.equal(R.botSimilarText({ amount_minor: 500, note: '', occurred_on: '2026-11-25' }, '餐饮', TODAY),
    '11月25日已经有一笔差不多的：餐饮 RM 5.00。还要记这一笔吗？');
  assert.equal(R.botSimilarText(null, '餐饮', TODAY), '已经有一笔差不多的账。还要记这一笔吗？');
});
test('大额先问：今天的账不显示日期；不是今天（用户决定 6）显示「· 月日」', () => {
  assert.equal(R.botBigText({ amount_minor: 999900, occurred_on: TODAY }, '餐饮', TODAY), '截图上的金额是 RM 9,999.00（餐饮），要记吗？');
  assert.equal(R.botBigText({ amount_minor: 999900, occurred_on: '2026-11-25' }, '餐饮', TODAY),
    '截图上的金额是 RM 9,999.00（餐饮 · 11月25日），要记吗？');
});
test('分类选单的提示：超过 30 个才加一句', () => {
  assert.equal(R.botCategoryPrompt(false), '要改成哪个分类？');
  assert.equal(R.botCategoryPrompt(true), '要改成哪个分类？（其余分类请到 App 改）');
});

// ---------- 按钮 ----------
test('已记的按钮：［改分类］［撤销］', () => {
  assert.deepEqual(R.botRecordedKeyboard(TX), { inline_keyboard: [[
    { text: '改分类', callback_data: `c:${TX}` }, { text: '撤销', callback_data: `u:${TX}` }]] });
});
test('先问的按钮：相似 ［还要记］［不用］；大额 ［要记］［不用］', () => {
  assert.deepEqual(R.botAskKeyboard(TX, 'similar'), { inline_keyboard: [[
    { text: '还要记', callback_data: `y:${TX}` }, { text: '不用', callback_data: `n:${TX}` }]] });
  assert.equal(R.botAskKeyboard(TX, 'big').inline_keyboard[0][0].text, '要记');
});
test('同意按钮、没连接的「记账」按钮', () => {
  assert.deepEqual(R.botConsentKeyboard(), { inline_keyboard: [[{ text: '同意并开始', callback_data: 'a:1' }]] });
  assert.deepEqual(R.botUnlinkedKeyboard(), { inline_keyboard: [[{ text: '记账', web_app: { url: 'https://jizhang.adteoh.com/' } }]] });
});

test('botCatHash：SHA-256 前 8 位 hex', async () => {
  const { createHash } = await import('node:crypto');
  assert.equal(await R.botCatHash('food'), createHash('sha256').update('food').digest('hex').slice(0, 8));
});

test('分类选单：每排 3 个、按清单顺序、最后［取消］；按钮资料 ≤ 64 bytes（64 字分类 id 也一样）', async () => {
  const cats = [{ id: 'food', name: '餐饮' }, { id: 'x'.repeat(64), name: '长' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }];
  const { markup, truncated } = await R.botCategoryKeyboard(TX, cats);
  assert.equal(truncated, false);
  const rows = markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r.length), [3, 1, 1]);
  assert.deepEqual(rows[0][0], { text: '餐饮', callback_data: `s:${TX}:0:${await R.botCatHash('food')}` });
  assert.equal(rows[1][0].callback_data, `s:${TX}:3:${await R.botCatHash('d')}`);
  assert.deepEqual(rows[2], [{ text: '取消', callback_data: `b:${TX}` }]);
  for (const r of rows) for (const b of r) assert.ok(bytes(b.callback_data) <= 64, b.callback_data);
});

test('分类选单：超过 30 个只放前 30、truncated', async () => {
  const cats = Array.from({ length: 35 }, (_, i) => ({ id: 'c' + i, name: 'N' + i }));
  const { markup, truncated } = await R.botCategoryKeyboard(TX, cats);
  assert.equal(truncated, true);
  assert.equal(markup.inline_keyboard.flat().length, 31);
});

test('botParseCallback：合格的', () => {
  assert.deepEqual(R.botParseCallback(`u:${TX}`), { op: 'u', id: TX });
  for (const op of ['c', 'b', 'y', 'n']) assert.deepEqual(R.botParseCallback(`${op}:${TX}`), { op, id: TX });
  assert.deepEqual(R.botParseCallback(`s:${TX}:12:0a1b2c3d`), { op: 's', id: TX, idx: 12, h: '0a1b2c3d' });
  assert.deepEqual(R.botParseCallback('a:1'), { op: 'a' });
});

test('botParseCallback：不合格一律 null', () => {
  for (const d of [`U:${TX}`, `u:${TX.toUpperCase()}`, `u:${TX}:1`, `x:${TX}`, 'u:not-a-uuid', `s:${TX}:99999:0a1b2c3d`,
    `s:${TX}:30:0a1b2c3d`, `s:${TX}:1:0a1b2c3`, `s:${TX}:1:0A1B2C3D`, `s:${TX}::0a1b2c3d`, 'a:2', 'a:', '', null, 5,
    `u:${TX}${'x'.repeat(30)}`]) {
    assert.equal(R.botParseCallback(d), null, String(d));
  }
});

test('审核：botFormatRM 0 与负数与 App 相同；大额按钮完整', () => {
  for (const m of [0, -690, -300000]) assert.equal(R.botFormatRM(m), formatRM(m), String(m));
  assert.deepEqual(R.botAskKeyboard(TX, 'big'), { inline_keyboard: [[
    { text: '要记', callback_data: `y:${TX}` }, { text: '不用', callback_data: `n:${TX}` }]] });
});
test('审核：选分类序号不许前导零', () => {
  assert.equal(R.botParseCallback(`s:${TX}:07:0a1b2c3d`), null);
  assert.deepEqual(R.botParseCallback(`s:${TX}:0:0a1b2c3d`), { op: 's', id: TX, idx: 0, h: '0a1b2c3d' });
});

test('用户 2026-11-27：bot 给用户看的文字都不出现 Claude／Anthropic', async () => {
  const texts = Object.values(R).filter((v) => typeof v === 'string');
  texts.push(R.botRecordedText({ amountMinor: 690, categoryName: '餐饮', note: '早餐', occurredOn: TODAY, today: TODAY }),
    R.botSimilarText(null, '', TODAY), R.botBigText({ amount_minor: 100000, occurred_on: TODAY }, '餐饮', TODAY), R.botCategoryPrompt(true));
  assert.ok(texts.length >= 15, String(texts.length));
  for (const t of texts) assert.doesNotMatch(t, /claude|anthropic/i, t);
});

test('用户 2026-11-27：收入的已记／已撤销标明「收入」＋「+」；支出照旧；没给 kind 当支出', () => {
  const base = { amountMinor: 300000, categoryName: '工资', note: '', occurredOn: TODAY, today: TODAY };
  assert.equal(R.botRecordedText({ ...base, kind: 'income' }), '✅ 已记收入：工资 +RM 3,000.00');
  assert.equal(R.botUndoneText({ ...base, kind: 'income' }), '↩️ 已撤销收入：工资 +RM 3,000.00');
  assert.equal(R.botRecordedText({ ...base, kind: 'expense' }), '✅ 已记：工资 RM 3,000.00');
  assert.equal(R.botUndoneText(base), '↩️ 已撤销：工资 RM 3,000.00');
});

test('用户 2026-11-27：问句也标明收入（大额、相似、相似找不到）；支出照旧', () => {
  assert.equal(R.botBigText({ amount_minor: 300000, occurred_on: TODAY, kind: 'income' }, '工资', TODAY), '截图上的收入是 +RM 3,000.00（工资），要记吗？');
  assert.equal(R.botBigText({ amount_minor: 300000, occurred_on: '2026-11-25', kind: 'income' }, '工资', TODAY),
    '截图上的收入是 +RM 3,000.00（工资 · 11月25日），要记吗？');
  assert.equal(R.botBigText({ amount_minor: 300000, occurred_on: TODAY, kind: 'expense' }, '购物', TODAY), '截图上的金额是 RM 3,000.00（购物），要记吗？');
  assert.equal(R.botSimilarText({ amount_minor: 300000, note: '', occurred_on: TODAY }, '工资', TODAY, 'income'),
    '今天已经有一笔差不多的收入：工资 +RM 3,000.00。还要记这一笔吗？');
  assert.equal(R.botSimilarText(null, '', TODAY, 'income'), '已经有一笔差不多的收入。还要记这一笔吗？');
  assert.equal(R.botSimilarText({ amount_minor: 690, note: '', occurred_on: TODAY }, '餐饮', TODAY, 'expense'),
    '今天已经有一笔差不多的：餐饮 RM 6.90。还要记这一笔吗？');
});
