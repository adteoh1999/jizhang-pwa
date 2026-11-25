// 2f Task 8：邀请码页跟服务器说话的部分（假 fetch、记忆体资料库）。画面本身留给 Task 11 headless。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { ownerCall, loadInvites, createInvite, copyInvite, shareInvite, canShare, INVITE_TEXT } from '../js/ui/invites-page.js';
import { OWNER_FLAG_KEY, readOwnerFlag } from '../js/owner-check.js';
import { SUPABASE_URL } from '../js/config.js';

const FAR = Date.parse('2099-01-01T00:00:00Z');
const NOW = Date.parse('2026-11-25T10:00:00Z');
const sessionOf = (id, tok = `tok-${id}`) => ({ access_token: tok, refresh_token: `ref-${id}`, expires_at: FAR, user_id: id, email: `${id}@example.invalid`, platform: 'pwa' });
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
const INV = { code: 'K7MPQ4XZ', max_uses: 1, used_count: 0, active: true, expires_at: null, note: '', created_at: '2026-11-25T01:00:00+00:00', status: 'active' };

async function setup({ session = sessionOf('u-A'), reply = () => res(200, { invites: [INV] }), online = true, getSession } = {}) {
  const db = createMemoryDb();
  const store = createStore({ db });
  await store.init();
  await store.setMetas({ session, [OWNER_FLAG_KEY]: { userId: 'u-A', value: true, checkedAt: NOW } });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: url.replace(SUPABASE_URL, ''), body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
    return reply(url, init, calls.length);
  };
  const deps = { store, fetchFn, userId: 'u-A', isOnline: () => online, now: () => NOW, ...(getSession ? { getSession } : {}) };
  return { store, calls, deps };
}

test('离线：不叫服务器，回 offline 与「需要网络才能管理邀请码」', async () => {
  const { calls, deps } = await setup({ online: false });
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: false, reason: 'offline', message: INVITE_TEXT.offline });
  assert.equal(INVITE_TEXT.offline, '需要网络才能管理邀请码');
  assert.equal(calls.length, 0);
});

test('list 成功：回邀请码阵列，带这个账号的 token', async () => {
  const { calls, deps } = await setup();
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: true, invites: [INV] });
  assert.deepEqual(calls[0].body, { action: 'list' });
  assert.equal(calls[0].auth, 'Bearer tok-u-A');
});

test('list 回 2xx 但 invites 不是阵列 → 通用失败', async () => {
  const { deps } = await setup({ reply: () => res(200, { invites: 'x' }) });
  const r = await loadInvites(deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.equal(r.message, '暂时无法完成，请稍后再试');
});

test('403：回 denied「没有权限」，并把站主快取改成 false（入口会消失）', async () => {
  const { store, deps } = await setup({ reply: () => res(403, { error: '没有权限' }) });
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: false, reason: 'denied', message: INVITE_TEXT.denied });
  assert.equal(INVITE_TEXT.denied, '没有权限');
  assert.deepEqual(await store.getMeta(OWNER_FLAG_KEY), { userId: 'u-A', value: false, checkedAt: NOW });
  assert.equal(await readOwnerFlag(store, 'u-A'), false);
});

test('断网或超时（status 0）→ offline，不改站主快取', async () => {
  const { store, deps } = await setup({ reply: () => { throw new TypeError('net'); } });
  const r = await loadInvites(deps);
  assert.equal(r.reason, 'offline');
  assert.equal(await readOwnerFlag(store, 'u-A'), true);
});

test('服务器 500 → error，显示服务器认得的中文或通用句', async () => {
  const { deps } = await setup({ reply: () => res(500, { error: '暂时无法完成，请稍后再试' }) });
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: false, reason: 'error', message: '暂时无法完成，请稍后再试' });
});

test('登录失效 → relogin，不叫服务器', async () => {
  const { calls, deps } = await setup({ session: { ...sessionOf('u-A'), invalid: true } });
  const r = await loadInvites(deps);
  assert.equal(r.reason, 'relogin');
  assert.equal(r.message, INVITE_TEXT.relogin);
  assert.equal(calls.length, 0);
});

test('拿 session 连不上（retry）→ error「暂时连不上」，不叫服务器', async () => {
  const { calls, deps } = await setup({ getSession: async () => ({ retry: true }) });
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: false, reason: 'error', message: INVITE_TEXT.retry });
  assert.equal(calls.length, 0);
});

test('资料库里已经是别的账号 → switched，不叫服务器', async () => {
  const { calls, deps } = await setup({ session: sessionOf('u-B') });
  const r = await loadInvites(deps);
  assert.equal(r.reason, 'switched');
  assert.equal(r.message, INVITE_TEXT.switched);
  assert.equal(calls.length, 0);
});

test('401 → 用 failedToken 刷新一次再叫；第二次成功就回成功', async () => {
  const asked = [];
  const getSession = async (failedToken) => { asked.push(failedToken); return { session: sessionOf('u-A', failedToken ? 'tok-new' : 'tok-old') }; };
  const { calls, deps } = await setup({ getSession, reply: (u, i, n) => (n === 1 ? res(401, {}) : res(200, { invites: [] })) });
  const r = await loadInvites(deps);
  assert.deepEqual(r, { ok: true, invites: [] });
  assert.deepEqual(asked, [null, 'tok-old']);
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer tok-old', 'Bearer tok-new']);
});

test('401 两次 → relogin；刷新后变成别的账号 → switched、不再叫', async () => {
  const g1 = async (ft) => ({ session: sessionOf('u-A', ft ? 'tok-new' : 'tok-old') });
  const a = await setup({ getSession: g1, reply: () => res(401, {}) });
  assert.equal((await loadInvites(a.deps)).reason, 'relogin');
  assert.equal(a.calls.length, 2);
  const g2 = async (ft) => ({ session: ft ? sessionOf('u-B') : sessionOf('u-A') });
  const b = await setup({ getSession: g2, reply: () => res(401, {}) });
  assert.equal((await loadInvites(b.deps)).reason, 'switched');
  assert.equal(b.calls.length, 1);
});

test('新增：默认送 {max_uses:1, days:7, note:\'\'}，回 8 码', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { code: 'K7MPQ4XZ' }) });
  const r = await createInvite(deps, { maxUses: 1, days: 7, note: '' });
  assert.deepEqual(r, { ok: true, code: 'K7MPQ4XZ' });
  assert.deepEqual(calls[0].body, { action: 'create', max_uses: 1, days: 7, note: '' });
});

test('新增：选永不过期送 days:null（键一定要在，S3）；备注去掉前后空白；次数夹回 1–20', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { code: 'K7MPQ4XZ' }) });
  await createInvite(deps, { maxUses: 25, days: null, note: '  给阿明  ' });
  assert.ok('days' in calls[0].body);
  assert.deepEqual(calls[0].body, { action: 'create', max_uses: 20, days: null, note: '给阿明' });
});

test('新增：不在选项里的天数当默认 7；备注超过 40 字截掉', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { code: 'K7MPQ4XZ' }) });
  await createInvite(deps, { maxUses: 1, days: 14, note: '字'.repeat(45) });
  assert.equal(calls[0].body.days, 7);
  assert.equal(calls[0].body.note, '字'.repeat(40));
});

test('新增：回应的码不像邀请码 → 通用失败；离线 → offline 不叫', async () => {
  const a = await setup({ reply: () => res(200, { code: 123 }) });
  assert.deepEqual(await createInvite(a.deps, { maxUses: 1, days: 7, note: '' }), { ok: false, reason: 'error', message: '暂时无法完成，请稍后再试' });
  const c = await setup({ reply: () => res(200, { code: 'k7mp-q4xz' }) }); // 字串但不是 8 码大写英数
  assert.equal((await createInvite(c.deps, { maxUses: 1, days: 7, note: '' })).reason, 'error');
  const b = await setup({ online: false });
  assert.equal((await createInvite(b.deps, { maxUses: 1, days: 7, note: '' })).reason, 'offline');
  assert.equal(b.calls.length, 0);
});

test('ownerCall：action 与参数原样送出', async () => {
  const { calls, deps } = await setup({ reply: () => res(200, { ok: true }) });
  const r = await ownerCall(deps, 'set_active', { code: 'K7MPQ4XZ', active: false });
  assert.deepEqual(r, { ok: true, data: { ok: true } });
  assert.deepEqual(calls[0].body, { code: 'K7MPQ4XZ', active: false, action: 'set_active' });
});

test('canShare：只有 navigator.share 是函数才显示分享', () => {
  assert.equal(canShare({ share: () => {} }), true);
  assert.equal(canShare({}), false);
  assert.equal(canShare(undefined), false);
});

test('shareInvite：送固定句子；使用者取消（AbortError）回 cancel、其他错误回 fail', async () => {
  const got = [];
  assert.equal(await shareInvite('K7MPQ4XZ', { share: async (d) => { got.push(d); } }), 'done');
  assert.deepEqual(got, [{ text: '用邀请码 K7MP-Q4XZ 注册：https://jizhang.adteoh.com' }]);
  assert.equal(await shareInvite('K7MPQ4XZ', { share: async () => { throw new DOMException('x', 'AbortError'); } }), 'cancel');
  assert.equal(await shareInvite('K7MPQ4XZ', { share: async () => { throw new DOMException('x', 'NotAllowedError'); } }), 'fail');
  assert.equal(await shareInvite('K7MPQ4XZ', {}), 'fail');
});

test('copyInvite：复制带横线的码；没有剪贴簿或被拒 → false', async () => {
  const got = [];
  assert.equal(await copyInvite('K7MPQ4XZ', { writeText: async (t) => { got.push(t); } }), true);
  assert.deepEqual(got, ['K7MP-Q4XZ']);
  assert.equal(await copyInvite('K7MPQ4XZ', { writeText: async () => { throw new Error('denied'); } }), false);
  assert.equal(await copyInvite('K7MPQ4XZ', undefined), false);
});
