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

// ======================= Task 9：明细、停用／启用、移除用户 =======================
import { loadUses, useRowView, activeActionLabel, toggleInviteActive, runRemoveUser } from '../js/ui/invites-page.js';

const USE = { id: 5, email: 'b@example.invalid', used_at: '2026-12-01T16:30:00+00:00', deleted: false, owner: false, pending: false };

test('ownerCall：超时（timeout）→ reason timeout，跟断网分开', async () => {
  const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
  const { deps } = await setup({ reply: hang });
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...a) => orig(cb, Math.min(ms, 20), ...a); // 让 10 秒的计时器马上到期
  let r;
  try { r = await loadInvites(deps); } finally { globalThis.setTimeout = orig; }
  assert.deepEqual(r, { ok: false, reason: 'timeout', message: INVITE_TEXT.timeout });
});

test('loadUses：送 {action:uses, code}，回 uses 阵列；不是阵列当通用失败', async () => {
  const a = await setup({ reply: () => res(200, { uses: [USE] }) });
  assert.deepEqual(await loadUses(a.deps, 'K7MPQ4XZ'), { ok: true, uses: [USE] });
  assert.deepEqual(a.calls[0].body, { code: 'K7MPQ4XZ', action: 'uses' });
  const b = await setup({ reply: () => res(200, { uses: null }) });
  assert.equal((await loadUses(b.deps, 'K7MPQ4XZ')).reason, 'error');
});

test('useRowView：一般用户 → 邮箱、注册于 M月D日（马来西亚时间）、可以移除，按钮名称带邮箱', () => {
  assert.deepEqual(useRowView(USE), {
    title: 'b@example.invalid', detail: '注册于 12月2日', owner: false, removable: true, removeLabel: '移除 b@example.invalid',
  });
});

test('useRowView：已删除 → 「已删除的用户」、不显示邮箱、没有移除', () => {
  const v = useRowView({ ...USE, deleted: true, email: 'leak@example.invalid' });
  assert.equal(v.title, '已删除的用户');
  assert.equal(v.detail, '注册于 12月2日');
  assert.equal(v.removable, false);
  assert.ok(!JSON.stringify(v).includes('leak@'));
});

test('useRowView：站主 → 标站主、没有移除；注册未完成（pending）→ 没有移除', () => {
  const o = useRowView({ ...USE, owner: true });
  assert.equal(o.owner, true);
  assert.equal(o.removable, false);
  const p = useRowView({ ...USE, pending: true });
  assert.equal(p.detail, '注册未完成');
  assert.equal(p.removable, false);
});

test('useRowView：邮箱已清空但还没标已删除（删除未完成，S6）→ 「删除未完成的用户」、可以再移除', () => {
  const v = useRowView({ ...USE, email: '' });
  assert.equal(v.title, '删除未完成的用户');
  assert.equal(v.removable, true);
  assert.equal(v.removeLabel, '移除 删除未完成的用户');
});

test('activeActionLabel：有效时「停用这个邀请码」，停用后「重新启用」', () => {
  assert.equal(activeActionLabel({ active: true }), '停用这个邀请码');
  assert.equal(activeActionLabel({ active: false }), '重新启用');
});

test('toggleInviteActive：送 set_active（相反的值），再拉清单拿服务器算的状态；停用后按钮变「重新启用」', async () => {
  const after = { ...INV, active: false, status: 'disabled' };
  const { calls, deps } = await setup({ reply: (u, init, n) => (n === 1 ? res(200, { ok: true }) : res(200, { invites: [after] })) });
  const r = await toggleInviteActive(deps, INV);
  assert.deepEqual(calls[0].body, { code: 'K7MPQ4XZ', active: false, action: 'set_active' });
  assert.deepEqual(calls[1].body, { action: 'list' });
  assert.deepEqual(r, { ok: true, invite: after });
  assert.equal(activeActionLabel(r.invite), '重新启用');
});

test('toggleInviteActive：改成功但重拉清单失败 → 用本地推算（停用 → disabled）', async () => {
  const { deps } = await setup({ reply: (u, init, n) => (n === 1 ? res(200, { ok: true }) : res(500, {})) });
  const r = await toggleInviteActive(deps, INV);
  assert.equal(r.ok, true);
  assert.equal(r.invite.active, false);
  assert.equal(r.invite.status, 'disabled');
});

test('toggleInviteActive：服务器说找不到 → 失败、不改', async () => {
  const { deps } = await setup({ reply: () => res(404, { error: '找不到这个邀请码' }) });
  assert.deepEqual(await toggleInviteActive(deps, INV), { ok: false, reason: 'error', message: '找不到这个邀请码' });
});

async function removeSetup({ choice = 'continue', confirm = true, reply = () => res(200, { ok: true }) } = {}) {
  const ctx = await setup({ reply });
  const log = [];
  const dialogs = {
    choiceDialog: async (o) => { log.push(`choice:${o.title}`); dialogs.lastChoice = o; return choice; },
    confirmDialog: async (o) => { log.push(`confirm:${o.title}`); dialogs.lastConfirm = o; return confirm; },
    messageDialog: async (o) => { log.push(`message:${o.title}`); dialogs.lastMessage = o; },
  };
  const block = () => { log.push('block'); return () => log.push('unblock'); };
  return { ...ctx, log, dialogs, block };
}

test('移除：两次确认（第二次要输入「删除」）才叫 remove_user，带 code 与 use_id', async () => {
  const { calls, log, dialogs, block, deps } = await removeSetup();
  assert.equal(await runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }), 'done');
  const c = dialogs.lastChoice;
  assert.equal(c.title, '移除这个用户？');
  assert.equal(c.message, '会永久删除 b@example.invalid 的账号和全部数据，无法复原。对方想再用需要新的邀请码。');
  assert.deepEqual(c.buttons.map((b) => b.label), ['取消', '继续']);
  assert.equal(c.buttons[0].focus, true);
  assert.equal(c.buttons[1].destructive, true);
  const k = dialogs.lastConfirm;
  assert.equal(k.requireText, '删除');
  assert.equal(k.confirmLabel, '永久删除');
  assert.equal(k.destructive, true);
  assert.deepEqual(calls.map((x) => x.body), [{ code: 'K7MPQ4XZ', use_id: 5, action: 'remove_user' }]);
  assert.deepEqual(log, ['choice:移除这个用户？', 'confirm:确定永久删除？', 'block', 'unblock']);
});

test('移除：第一步取消、第二步取消 → 都不叫服务器、回 cancel', async () => {
  for (const o of [{ choice: null }, { confirm: false }]) {
    const { calls, dialogs, block, deps } = await removeSetup(o);
    assert.equal(await runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }), 'cancel');
    assert.equal(calls.length, 0);
  }
});

test('移除：已删除、站主、注册未完成的列 → 不问也不叫', async () => {
  for (const use of [{ ...USE, deleted: true }, { ...USE, owner: true }, { ...USE, pending: true }]) {
    const { calls, log, dialogs, block, deps } = await removeSetup();
    assert.equal(await runRemoveUser(deps, { code: 'K7MPQ4XZ', use, dialogs, block }), 'cancel');
    assert.equal(calls.length, 0);
    assert.deepEqual(log, []);
  }
});

test('移除：删除未完成的列，确认文字用「这个用户」', async () => {
  const { dialogs, block, deps } = await removeSetup();
  await runRemoveUser(deps, { code: 'K7MPQ4XZ', use: { ...USE, email: '' }, dialogs, block });
  assert.equal(dialogs.lastChoice.message, '会永久删除这个用户的账号和全部数据，无法复原。对方想再用需要新的邀请码。');
});

test('移除：服务器失败 → 放开画面后显示服务器的中文、回 fail', async () => {
  const { log, dialogs, block, deps } = await removeSetup({ reply: () => res(403, { error: '不能移除站主' }) });
  // 403 在这里是「不能移除站主」，不是没有权限：照样显示服务器的句子
  assert.equal(await runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }), 'fail');
  assert.equal(dialogs.lastMessage.title, '没能移除这个用户');
  assert.ok(log.indexOf('unblock') < log.indexOf('message:没能移除这个用户'));
  assert.equal(dialogs.lastMessage.message, '不能移除站主');
  assert.equal(await readOwnerFlag(deps.store, 'u-A'), true, '「不能移除站主」不是没有权限：站主快取不能被改掉');
});

test('移除：超时 → 说明「可能已经移除」（列表会重新载入）、回 fail', async () => {
  const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError'))));
  const { dialogs, block, deps } = await removeSetup({ reply: hang });
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...a) => orig(cb, Math.min(ms, 20), ...a);
  let r;
  try { r = await runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }); } finally { globalThis.setTimeout = orig; }
  assert.equal(r, 'fail');
  assert.equal(dialogs.lastMessage.title, '没收到回应');
  assert.equal(dialogs.lastMessage.message, INVITE_TEXT.removeTimeout);
});

test('移除：连按两次只跑一次', async () => {
  const { calls, dialogs, block, deps } = await removeSetup();
  const [a, b] = await Promise.all([
    runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }),
    runRemoveUser(deps, { code: 'K7MPQ4XZ', use: USE, dialogs, block }),
  ]);
  assert.deepEqual([a, b].sort(), ['cancel', 'done']);
  assert.equal(calls.length, 1);
});

test('toggleInviteActive：重新启用一个已过期的码 → 用服务器算的「已过期」，不是本地猜的「有效」', async () => {
  const before = { ...INV, active: false, status: 'disabled', expires_at: '2026-11-01T00:00:00+00:00' };
  const after = { ...before, active: true, status: 'expired' };
  const { deps } = await setup({ reply: (u, init, n) => (n === 1 ? res(200, { ok: true }) : res(200, { invites: [after] })) });
  const r = await toggleInviteActive(deps, before);
  assert.equal(r.invite.status, 'expired');
  assert.equal(activeActionLabel(r.invite), '停用这个邀请码');
});
