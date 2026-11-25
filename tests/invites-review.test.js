// 2f-3 审核修正（fable-reviewer 2026-11-25：必须改 1＋建议改 2–9）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { css, blockAfter } from './helpers/css-tokens.js';
import * as P from '../js/ui/invites-page.js';

// namespace import：新函数还不存在时每条测试各自失败（逐条看 RED）
const { createInvite, shareInvite, runRemoveUser, INVITE_TEXT } = P;
const toggleAndNotify = (...a) => P.toggleAndNotify(...a);
const createFollowUp = (...a) => P.createFollowUp(...a);
const createGuardedRunner = (...a) => P.createGuardedRunner(...a);
const firstVisible = (...a) => P.firstVisible(...a);
import { refreshOwnerFlag, OWNER_FLAG_KEY } from '../js/owner-check.js';
import { SUPABASE_URL } from '../js/config.js';

const FAR = Date.parse('2099-01-01T00:00:00Z');
const NOW = Date.parse('2026-11-25T10:00:00Z');
const SESSION = { access_token: 'tok-A', refresh_token: 'ref-A', expires_at: FAR, user_id: 'u-A', email: 'a@example.invalid', platform: 'pwa' };
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
const INV = { code: 'K7MPQ4XZ', max_uses: 1, used_count: 0, active: true, expires_at: null, note: '', created_at: '2026-11-25T01:00:00+00:00', status: 'active' };
const USE = { id: 5, email: 'b@example.invalid', used_at: '2026-12-01T16:30:00+00:00', deleted: false, owner: false, pending: false };
const SRC = readFileSync(new URL('../js/ui/invites-page.js', import.meta.url), 'utf8');

async function setup({ reply = () => res(200, { ok: true }), flag } = {}) {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session: SESSION, ...(flag ? { [OWNER_FLAG_KEY]: flag } : {}) });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: url.replace(SUPABASE_URL, ''), body: init.body ? JSON.parse(init.body) : null });
    return reply(url, init, calls.length);
  };
  return { store, calls, deps: { store, fetchFn, userId: 'u-A', isOnline: () => true, now: () => NOW } };
}

// ---------- 必须改 1：长按复制不能带到读屏用的隐藏文字 ----------
test('审核 1：user-select: all 只放在看得见的码上；读屏文字不可选取', () => {
  assert.ok(!/user-select/.test(blockAfter(css, '.invite-big-code {')), '.invite-big-code 本身不能整段可选');
  assert.match(blockAfter(css, '.invite-big-code-text {'), /(^|[^-])user-select:\s*all/);
  assert.match(blockAfter(css, '.invite-big-code .sr-only {'), /(^|[^-])user-select:\s*none/);
  assert.ok(SRC.includes("h('span', { class: 'invite-big-code-text', 'aria-hidden': 'true' }, formatCode(code))"), '看得见的码要用 invite-big-code-text');
  assert.ok(SRC.includes('range.selectNodeContents(bigText)'), '复制失败时只选取看得见的码');
});

// ---------- 建议 2：停用／启用成功就通知列表（就算页面已关）----------
test('审核 2：toggleAndNotify 成功一定叫 onChanged（不看页面关了没）；失败不叫', async () => {
  const after = { ...INV, active: false, status: 'disabled' };
  const a = await setup({ reply: (u, i, n) => (n === 1 ? res(200, { ok: true }) : res(200, { invites: [after] })) });
  let changed = 0;
  const r = await toggleAndNotify(a.deps, INV, { onChanged: () => { changed += 1; } });
  assert.equal(r.ok, true);
  assert.equal(changed, 1);
  const b = await setup({ reply: () => res(404, { error: '找不到这个邀请码' }) });
  changed = 0;
  assert.equal((await toggleAndNotify(b.deps, INV, { onChanged: () => { changed += 1; } })).ok, false);
  assert.equal(changed, 0);
});

test('审核 2：明细页的停用流程经过 toggleAndNotify（closed 检查在通知之后）', () => {
  const i = SRC.indexOf('async function onToggle()');
  const body = SRC.slice(i, SRC.indexOf('\n  }\n', i));
  assert.ok(i >= 0 && body.includes('toggleAndNotify(deps, inv, { onChanged })'));
  assert.ok(!body.includes('toggleInviteActive('), '不能绕过 toggleAndNotify');
});

// ---------- 建议 3：新增超时 → 关表单、重载列表、说明「可能已经生成」----------
test('审核 3：createFollowUp：成功显示码；超时关表单并重载；没有权限另外处理；其他只说明', () => {
  assert.deepEqual(createFollowUp({ ok: true, code: 'K7MPQ4XZ' }), { close: true, reload: false, showCode: true, message: null });
  assert.deepEqual(createFollowUp({ ok: false, reason: 'timeout', message: 'x' }),
    { close: true, reload: true, showCode: false, message: INVITE_TEXT.createTimeout });
  assert.equal(INVITE_TEXT.createTimeout, '没收到服务器的回应，邀请码可能已经生成。列表已重新载入，请先看一下再决定要不要再生成。');
  assert.deepEqual(createFollowUp({ ok: false, reason: 'denied', message: '没有权限' }), { close: true, reload: true, showCode: false, message: '没有权限' });
  assert.deepEqual(createFollowUp({ ok: false, reason: 'offline', message: '需要网络才能管理邀请码' }),
    { close: false, reload: false, showCode: false, message: '需要网络才能管理邀请码' });
});

// ---------- 建议 4：移除完（含失败、超时）先重载明细，再弹说明 ----------
async function removeCtx(reply) {
  const ctx = await setup({ reply });
  const log = [];
  const dialogs = {
    choiceDialog: async () => 'continue',
    confirmDialog: async () => true,
    messageDialog: async (o) => { log.push(`message:${o.title}`); },
  };
  const block = () => { log.push('block'); return () => log.push('unblock'); };
  const onSettled = async () => { log.push('settled'); };
  return { ...ctx, log, opts: { code: 'K7MPQ4XZ', use: USE, dialogs, block, onSettled } };
}

test('审核 4：移除成功 → 放开后叫 onSettled（重载明细）', async () => {
  const { log, deps, opts } = await removeCtx(() => res(200, { ok: true }));
  assert.equal(await runRemoveUser(deps, opts), 'done');
  assert.deepEqual(log, ['block', 'unblock', 'settled']);
});

test('审核 4：移除失败 → 先 onSettled（重载）再弹说明', async () => {
  const { log, deps, opts } = await removeCtx(() => res(500, { error: '暂时无法完成，请稍后再试' }));
  assert.equal(await runRemoveUser(deps, opts), 'fail');
  assert.deepEqual(log, ['block', 'unblock', 'settled', `message:${INVITE_TEXT.removeFailTitle}`]);
});

test('审核 4：移除超时 → 先 onSettled（重载）再弹「没收到回应」', async () => {
  const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
  const { log, deps, opts } = await removeCtx(hang);
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...a) => orig(cb, Math.min(ms, 20), ...a);
  try { assert.equal(await runRemoveUser(deps, opts), 'fail'); } finally { globalThis.setTimeout = orig; }
  assert.deepEqual(log, ['block', 'unblock', 'settled', `message:${INVITE_TEXT.removeTimeoutTitle}`]);
});

test('审核 4：onSettled 自己丢错也照样弹说明、回 fail', async () => {
  const { log, deps, opts } = await removeCtx(() => res(500, {}));
  opts.onSettled = async () => { log.push('settled'); throw new Error('boom'); };
  assert.equal(await runRemoveUser(deps, opts), 'fail');
  assert.ok(log.includes(`message:${INVITE_TEXT.removeFailTitle}`));
});

test('审核 4：取消后还能再移除（旗标有复位）', async () => {
  const { calls, deps, opts } = await removeCtx(() => res(200, { ok: true }));
  assert.equal(await runRemoveUser(deps, { ...opts, dialogs: { ...opts.dialogs, choiceDialog: async () => null } }), 'cancel');
  assert.equal(await runRemoveUser(deps, opts), 'done');
  assert.equal(calls.length, 1);
});

// ---------- 建议 5：站主判断只把「没有权限」的 403 当不是站主 ----------
test('审核 5：check 回 403 但不是「没有权限」（平台层）→ null、不写快取', async () => {
  const old = { userId: 'u-A', value: true, checkedAt: NOW - 2 * 24 * 3600 * 1000 };
  const { store, deps } = await setup({ flag: old, reply: () => res(403, { message: 'Forbidden' }) });
  assert.equal(await refreshOwnerFlag(store, deps), null);
  assert.deepEqual(await store.getMeta(OWNER_FLAG_KEY), old);
});

// ---------- 建议 6：「生成」出意外也要复位，不卡住表单 ----------
test('审核 6：createGuardedRunner：执行中再叫回 null；fn 丢错也会叫 onEnd，回通用失败', async () => {
  const log = [];
  let release;
  const run = createGuardedRunner({ onStart: () => log.push('start'), onEnd: () => log.push('end') });
  const p = run(() => new Promise((r) => { release = r; }));
  assert.equal(await run(async () => 'second'), null);
  release({ ok: true });
  assert.deepEqual(await p, { ok: true });
  const r = await run(async () => { throw new Error('IndexedDB closed'); });
  assert.deepEqual(r, { ok: false, reason: 'error', message: INVITE_TEXT.generic });
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
});

test('审核 6：生成按钮忙碌时用 aria-disabled＋「正在生成…」，不用 disabled', () => {
  const i = SRC.indexOf('function openNewInviteSheet(');
  const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.ok(i >= 0);
  assert.ok(!body.includes('rightButton.disabled'), '不能用 disabled（Safari 会丢焦点）');
  assert.ok(body.includes("setAttribute('aria-disabled', 'true')"));
  assert.ok(body.includes('T.generating'));
  assert.equal(INVITE_TEXT.generating, '正在生成…');
});

// ---------- 建议 7：元素被藏起来时焦点不掉 ----------
const fakeEl = (name, { connected = true, hiddenAncestor = false } = {}) => ({
  name, isConnected: connected, closest: (sel) => (sel === '[hidden]' && hiddenAncestor ? {} : null),
});

test('审核 7：firstVisible 跳过已离开画面、或自己／祖先被藏起来的元素', () => {
  const a = fakeEl('a', { connected: false });
  const b = fakeEl('b', { hiddenAncestor: true });
  const c = fakeEl('c');
  assert.equal(firstVisible([null, a, b, c]), c);
  assert.equal(firstVisible([a, b]), null);
});

test('审核 7：列表重画时焦点放回同一个码那一列（记住 data-code）', () => {
  const i = SRC.indexOf('function renderList(');
  const body = SRC.slice(i, SRC.indexOf('\n  }\n', i));
  assert.ok(i >= 0 && body.includes('dataset.code'), 'renderList 要记住原本焦点那一列的 data-code');
});

test('审核 7：邀请码页、明细页把有焦点的东西藏起来时，都经过 keepFocus 找下一个焦点；关页时 opener 不见了有后备', () => {
  const calls = SRC.split('keepFocus(page,').length - 1;
  assert.ok(calls >= 4, `keepFocus 呼叫 ${calls} 次`); // 列表：载入中、失败；明细：载入中、失败
  const i = SRC.indexOf('export function openInvitesPage(');
  const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
  assert.ok(body.includes('firstVisible([opener])') && body.includes('restoreFocus()'), '设置页那一列被藏起来时要有后备焦点');
});

// ---------- 建议 8：分享面板还开着时再按，不算错 ----------
test('审核 8：shareInvite 遇到 InvalidStateError（面板还开着）回 cancel', async () => {
  assert.equal(await shareInvite('K7MPQ4XZ', { share: async () => { throw new DOMException('x', 'InvalidStateError'); } }), 'cancel');
});

test('审核 8：结果 sheet 的分享有「分享中」旗标', () => {
  const i = SRC.indexOf('function onShare()');
  const body = SRC.slice(i, SRC.indexOf('\n  }\n', i));
  assert.ok(i >= 0 && body.includes('if (sharing) return;'));
});

// ---------- 建议 9：备注按字符截，不切半个表情符号 ----------
test('审核 9：备注第 40 个字是表情符号 → 整个保留，不切成半个', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { code: 'K7MPQ4XZ' }) });
  await createInvite(deps, { maxUses: 1, days: 7, note: `${'字'.repeat(39)}😀尾巴` });
  assert.equal(calls[0].body.note, `${'字'.repeat(39)}😀`);
  assert.equal([...calls[0].body.note].length, 40);
});

test('审核 9：截完尾端是空白也去掉', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { code: 'K7MPQ4XZ' }) });
  await createInvite(deps, { maxUses: 1, days: 7, note: `${'字'.repeat(39)} 尾` });
  assert.equal(calls[0].body.note, '字'.repeat(39));
});
