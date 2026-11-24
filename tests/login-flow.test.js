// 2d：登录流程状态机（js/login-flow.js）——不碰 DOM
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginFlow } from '../js/login-flow.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { savePending, loadPending, loadSession, loadLastUserId, saveLastUserId } from '../js/auth.js';

const T0 = Date.parse('2026-11-23T10:00:00Z');
const NET = '连不上网络，请检查后再试';
const session = (id = 'u-1') => ({ access_token: 'a', refresh_token: 'r', expires_at: T0 + 3600e3, user_id: id, email: 'me@x.com', platform: 'pwa' });

// 可控制的假 api：每个方法记录调用；回应由 handlers 决定（可回 Promise 延迟）
function fakeApi(handlers = {}) {
  const calls = { registerEmail: [], requestOtp: [], verifyOtp: [] };
  const api = {
    registerEmail: (...a) => { calls.registerEmail.push(a); return (handlers.registerEmail || (() => ({ ok: true })))(...a); },
    requestOtp: (...a) => { calls.requestOtp.push(a); return (handlers.requestOtp || (() => ({ ok: true })))(...a); },
    verifyOtp: (...a) => { calls.verifyOtp.push(a); return (handlers.verifyOtp || (() => ({ ok: true, session: session() })))(...a); },
  };
  return { api, calls };
}

function setup({ handlers, nowRef = { t: T0 }, db = createMemoryDb(), hasLocalData = () => false, confirmSwitch = async () => true } = {}) {
  const store = createStore({ db });
  const { api, calls } = fakeApi(handlers);
  const signed = [];
  const switches = [];
  const flow = createLoginFlow({
    api, store, now: () => nowRef.t, hasLocalData,
    confirmSwitch: async () => { switches.push(1); return confirmSwitch(); },
    onSignedIn: (s) => signed.push(s),
  });
  return { flow, store, db, calls, signed, switches, nowRef };
}
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('start：没有 pending → 欢迎页', async () => {
  const { flow } = setup();
  await flow.start();
  assert.equal(flow.state.step, 'welcome');
});

test('Review Focus 1：有效的 pending → 重开后直接在验证码页，邮箱相同', async () => {
  const { flow, store } = setup();
  await savePending(store, { email: 'me@x.com', sentAt: T0 - 30_000 });
  await flow.start();
  assert.equal(flow.state.step, 'code');
  assert.equal(flow.state.email, 'me@x.com');
  assert.equal(flow.resendLeft(), 30);
});

test('Review Focus 5a：pending 超过 10 分钟 → 邮箱页、邮箱已填、提示过期', async () => {
  const { flow, store } = setup();
  await savePending(store, { email: 'me@x.com', sentAt: T0 - 601_000 });
  await flow.start();
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.email, 'me@x.com');
  assert.equal(flow.state.notice, '验证码已过期，请重新发送');
  assert.equal(await loadPending(store, T0), null);
});

test('Review Focus 5b：停在验证码页超过 10 分钟才输入 → 回邮箱页，不发验证请求', async () => {
  const { flow, calls, nowRef } = setup();
  await flow.start();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'code');
  nowRef.t += 601_000;
  await flow.inputCode('123456');
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.notice, '验证码已过期，请重新发送');
  assert.equal(calls.verifyOtp.length, 0);
});

test('submitEmail：邮箱不对 → 错误、不发请求', async () => {
  const { flow, calls } = setup();
  flow.goEmail();
  await flow.submitEmail('abc', '');
  assert.equal(flow.state.error, '请输入正确的邮箱');
  assert.equal(calls.registerEmail.length, 0);
});

test('submitEmail：成功 → 先 register 再 otp，存 pending，进验证码页', async () => {
  const { flow, calls, store } = setup();
  flow.goEmail();
  await flow.submitEmail(' Me@X.com ', ' k7mp-q4xz ');
  assert.deepEqual(calls.registerEmail[0], ['me@x.com', ' k7mp-q4xz ']);
  assert.deepEqual(calls.requestOtp[0], ['me@x.com']);
  assert.equal(flow.state.step, 'code');
  assert.equal(flow.state.busy, false);
  assert.deepEqual(await loadPending(store, T0), { email: 'me@x.com', sentAt: T0, expired: false });
});

test('submitEmail：register 403 → 显示讯息、不调 otp、留在邮箱页', async () => {
  const { flow, calls } = setup({ handlers: { registerEmail: () => ({ ok: false, message: '需要有效的邀请码' }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.error, '需要有效的邀请码');
  assert.equal(calls.requestOtp.length, 0);
  assert.equal(flow.state.step, 'email');
});

test('Review Focus 4：网络错 → busy 复位、网络讯息、留在原页', async () => {
  const { flow } = setup({ handlers: { registerEmail: () => ({ ok: false, status: 0, message: NET }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.busy, flow.state.error, flow.state.step], [false, NET, 'email']);
});

test('api 意外 throw → busy 仍复位', async () => {
  const { flow } = setup({ handlers: { registerEmail: () => { throw new Error('boom'); } } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.busy, false);
  assert.equal(typeof flow.state.error, 'string');
  assert.ok(flow.state.error.length > 0);
});

test('Review Focus 3a：发送中再按一次 → 只发一次', async () => {
  const d = deferred();
  const { flow, calls } = setup({ handlers: { registerEmail: () => d.p } });
  flow.goEmail();
  const a = flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.busy, 'send');
  const b = flow.submitEmail('me@x.com', '');
  d.resolve({ ok: true });
  await Promise.all([a, b]);
  assert.equal(calls.registerEmail.length, 1);
  assert.equal(calls.requestOtp.length, 1);
});

test('同一邮箱、pending 还有效 → 直接进验证码页，不发请求', async () => {
  const { flow, calls, store } = setup();
  await savePending(store, { email: 'me@x.com', sentAt: T0 - 20_000 });
  flow.goEmail();
  await flow.submitEmail('ME@x.com', '');
  assert.equal(flow.state.step, 'code');
  assert.equal(calls.registerEmail.length, 0);
});

test('otp 回「刚寄过」（Auth 60 秒或钩子秒数）→ 进验证码页，提示刚才已寄出', async () => {
  const { flow, store } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 429, message: '请 42 秒后再试', retrySec: 42 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'code');
  assert.equal(flow.state.notice, '验证码刚才已寄出');
  assert.equal(flow.resendLeft(), 42);
  assert.equal((await loadPending(store, T0)).email, 'me@x.com');
});

test('otp 回其他错误（例如已达上限）→ 留在邮箱页显示讯息', async () => {
  const { flow } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 429, message: '已达到上限，请 54 分钟后再试', retrySec: null }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.step, flow.state.error], ['email', '已达到上限，请 54 分钟后再试']);
});

test('savePending 写入失败 → 仍进验证码页（信已寄出）', async () => {
  const db = createMemoryDb();
  const { flow } = setup({ db });
  flow.goEmail();
  db.failNextWrite(new Error('disk'));
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'code');
});

test('resendLeft 与 resend：没到 60 秒不发；到了只调 otp、更新 sentAt', async () => {
  const { flow, calls, nowRef, store } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t = T0 + 18_000;
  assert.equal(flow.resendLeft(), 42);
  await flow.resend();
  assert.equal(calls.requestOtp.length, 1);
  nowRef.t = T0 + 61_000;
  assert.equal(flow.resendLeft(), 0);
  await flow.resend();
  assert.equal(calls.requestOtp.length, 2);
  assert.equal(calls.registerEmail.length, 1);
  assert.equal((await loadPending(store, nowRef.t)).sentAt, T0 + 61_000);
  assert.equal(flow.state.notice, '已重新发送');
});

test('Review Focus 3b：重发中再按 → 只发一次', async () => {
  const d = deferred();
  let n = 0;
  const { flow, calls, nowRef } = setup({ handlers: { requestOtp: () => (++n === 1 ? { ok: true } : d.p) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t += 61_000;
  const a = flow.resend();
  const b = flow.resend();
  d.resolve({ ok: true });
  await Promise.all([a, b]);
  assert.equal(calls.requestOtp.length, 2);
});

test('inputCode：清理后存起来；不满 6 位不送；满 6 位自动送出（用户决定 2）', async () => {
  const { flow, calls } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('48');
  assert.equal(flow.state.code, '48');
  assert.equal(calls.verifyOtp.length, 0);
  await flow.inputCode('481 203');
  assert.deepEqual(calls.verifyOtp[0].slice(0, 2), ['me@x.com', '481203']);
});

test('Review Focus 3c：自动送出时又按「进入记账」→ 只验证一次、onSignedIn 一次', async () => {
  const d = deferred();
  const { flow, calls, signed } = setup({ handlers: { verifyOtp: () => d.p } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  const a = flow.inputCode('481203');
  const b = flow.submitCode();
  const c = flow.inputCode('481203');
  d.resolve({ ok: true, session: session() });
  await Promise.all([a, b, c]);
  assert.equal(calls.verifyOtp.length, 1);
  assert.equal(signed.length, 1);
});

test('验证失败 → 显示讯息、清空验证码；同一组不会再自动送出', async () => {
  const { flow, calls } = setup({ handlers: { verifyOtp: () => ({ ok: false, status: 403, message: '验证码不对或已过期' }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('111111');
  assert.deepEqual([flow.state.error, flow.state.code, flow.state.step], ['验证码不对或已过期', '', 'code']);
  await flow.inputCode('111111');
  assert.equal(calls.verifyOtp.length, 1);
  await flow.inputCode('222222');
  assert.equal(calls.verifyOtp.length, 2);
});

test('登录成功 → 存 session、清 pending、记 lastUserId、onSignedIn 一次', async () => {
  const { flow, store, signed } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('481203');
  assert.deepEqual(await loadSession(store), session());
  assert.equal(await loadPending(store, T0), null);
  assert.equal(await loadLastUserId(store), 'u-1');
  assert.deepEqual(signed, [session()]);
});

test('saveSession 写入失败 → 显示讯息、回邮箱页、onSignedIn 没被调', async () => {
  const db = createMemoryDb();
  const { flow, signed } = setup({ db });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  db.failNextWrite(new Error('disk'));
  await flow.inputCode('481203');
  assert.equal(signed.length, 0);
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.error, '登录资料没存好，请重新发送验证码');
  assert.equal(flow.state.busy, false);
});

test('换账号：上次是 A、本地有账、这次登录 B → 先确认；不同意就不存 session、回欢迎页', async () => {
  const db = createMemoryDb();
  const { flow, store, signed, switches } = setup({ db, hasLocalData: () => true, confirmSwitch: async () => false, handlers: { verifyOtp: () => ({ ok: true, session: session('u-B') }) } });
  await saveLastUserId(store, 'u-A');
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('481203');
  assert.equal(switches.length, 1);
  assert.equal(signed.length, 0);
  assert.equal(await loadSession(store), null);
  assert.equal(flow.state.step, 'welcome');
  assert.equal(await loadLastUserId(store), 'u-A');
});

test('换账号：同意 → 正常登录；同一个账号或本地没账 → 不问', async () => {
  for (const [last, local, asked] of [['u-A', true, 1], ['u-1', true, 0], ['u-A', false, 0], [null, true, 0]]) {
    const { flow, store, signed, switches } = setup({ hasLocalData: () => local });
    if (last) await saveLastUserId(store, last);
    flow.goEmail();
    await flow.submitEmail('me@x.com', '');
    await flow.inputCode('481203');
    assert.equal(switches.length, asked, `${last} ${local}`);
    assert.equal(signed.length, 1, `${last} ${local}`);
  }
});

test('back：验证码页 → 邮箱页（pending 保留）→ 欢迎页；subscribe 会收到变化', async () => {
  const { flow, store } = setup();
  const seen = [];
  const off = flow.subscribe((s) => seen.push(s.step));
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  flow.back();
  assert.equal(flow.state.step, 'email');
  assert.notEqual(await loadPending(store, T0), null);
  flow.back();
  assert.equal(flow.state.step, 'welcome');
  off();
  flow.goEmail();
  assert.ok(seen.includes('code'));
  assert.equal(seen.at(-1), 'welcome');
});

// ---------- 审核后补（2026-11-24） ----------
test('busy 标示是哪个动作：send / resend / verify', async () => {
  const d = deferred();
  const { flow, nowRef } = setup({ handlers: { requestOtp: (() => { let n = 0; return () => (++n === 1 ? { ok: true } : d.p); })() } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t += 61_000;
  const p = flow.resend();
  assert.equal(flow.state.busy, 'resend');
  d.resolve({ ok: true });
  await p;
  const v = deferred();
  const { flow: f2 } = setup({ handlers: { verifyOtp: () => v.p } });
  f2.goEmail();
  await f2.submitEmail('me@x.com', '');
  const q = f2.inputCode('481203');
  assert.equal(f2.state.busy, 'verify');
  v.resolve({ ok: false, status: 403, message: '验证码不对或已过期' });
  await q;
});

test('Review Focus 4（验证）：网络错 / 429 / 5xx → 验证码保留、可以再按一次重试', async () => {
  for (const status of [0, 429, 503]) {
    let n = 0;
    const { flow, calls } = setup({ handlers: { verifyOtp: () => (++n === 1 ? { ok: false, status, message: 'x' } : { ok: true, session: session() }) } });
    flow.goEmail();
    await flow.submitEmail('me@x.com', '');
    await flow.inputCode('481203');
    assert.deepEqual([flow.state.code, flow.state.step, flow.state.busy], ['481203', 'code', false], String(status));
    await flow.submitCode();
    assert.equal(calls.verifyOtp.length, 2, String(status));
  }
});

test('Review Focus 4（寄信 / 重发）：otp 网络错 → 讯息、留在原页', async () => {
  const { flow } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 0, message: NET, retrySec: null }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.step, flow.state.error, flow.state.busy], ['email', NET, false]);
  let n = 0;
  const { flow: f2, nowRef } = setup({ handlers: { requestOtp: () => (++n === 1 ? { ok: true } : { ok: false, status: 0, message: NET, retrySec: null }) } });
  f2.goEmail();
  await f2.submitEmail('me@x.com', '');
  nowRef.t += 61_000;
  await f2.resend();
  assert.deepEqual([f2.state.step, f2.state.error, f2.state.busy], ['code', NET, false]);
});

test('saveSession 失败后再按「发送验证码」同一邮箱 → 真的重新 register + otp', async () => {
  const db = createMemoryDb();
  const { flow, calls } = setup({ db });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  db.failNextWrite(new Error('disk'));
  await flow.inputCode('481203');
  assert.equal(flow.state.step, 'email');
  await flow.submitEmail('me@x.com', '');
  assert.equal(calls.registerEmail.length, 2);
  assert.equal(calls.requestOtp.length, 2);
  assert.equal(flow.state.step, 'code');
});

test('错误带栏位与序号：同一句再错一次序号会变；邀请码相关错误指向 invite', async () => {
  const { flow } = setup({ handlers: { registerEmail: () => ({ ok: false, status: 403, message: '需要有效的邀请码' }) } });
  flow.goEmail();
  await flow.submitEmail('abc', '');
  const s1 = flow.state;
  assert.deepEqual([s1.error, s1.errorField], ['请输入正确的邮箱', 'email']);
  await flow.submitEmail('abc', '');
  assert.notEqual(flow.state.errorSeq, s1.errorSeq);
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.error, flow.state.errorField], ['需要有效的邀请码', 'invite']);
  const { flow: f2 } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 422, message: '这个邮箱还没注册，请填邀请码', retrySec: null }) } });
  f2.goEmail();
  await f2.submitEmail('me@x.com', '');
  assert.equal(f2.state.errorField, 'invite');
});

test('验证码不满 6 位按「进入记账」→ 提示，不发请求', async () => {
  const { flow, calls } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('48');
  await flow.submitCode();
  assert.equal(flow.state.error, '请输入 6 位数验证码');
  assert.equal(calls.verifyOtp.length, 0);
});

test('onSignedIn 丢错不会被吞成「出了点问题」，也不会被调两次', async () => {
  const store = createStore({ db: createMemoryDb() });
  const { api } = fakeApi();
  let n = 0;
  const flow = createLoginFlow({ api, store, now: () => T0, onSignedIn: () => { n++; throw new Error('mount 失败'); } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await assert.rejects(flow.inputCode('481203'), /mount 失败/);
  assert.equal(n, 1);
  assert.equal(flow.state.error, '');
});

test('retrySec 超过 60 也只当 60（倒数不会卡住）', async () => {
  const { flow } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 429, message: '请 90 秒后再试', retrySec: 90 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.resendLeft(), 60);
});

test('start 还没读完时用户已点「用邮箱登录」→ 不会被拉回欢迎页；读完前 ready 为 false', async () => {
  const { flow } = setup();
  assert.equal(flow.state.ready, false);
  const p = flow.start();
  flow.goEmail();
  await p;
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.ready, true);
});

test('checkExpiry（回前景）：刚好 600 秒算过期；过期后不能重发', async () => {
  const { flow, nowRef, calls } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t += 599_999;
  assert.equal(flow.checkExpiry(), false);
  nowRef.t += 1;
  assert.equal(flow.checkExpiry(), true);
  assert.equal(flow.state.step, 'email');
  await flow.resend();
  assert.equal(calls.requestOtp.length, 1);
});

test('提示序号：同一句提示再出现，noticeSeq 会变（读屏才会再念）', async () => {
  const { flow, nowRef } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t += 61_000;
  await flow.resend();
  const a = flow.state.noticeSeq;
  nowRef.t += 61_000;
  await flow.resend();
  assert.equal(flow.state.notice, '已重新发送');
  assert.notEqual(flow.state.noticeSeq, a);
});

test('saveSession 失败后马上重发、otp 回 60 秒限制 → 留在邮箱页显示秒数，不进验证码页', async () => {
  const db = createMemoryDb();
  let n = 0;
  const { flow } = setup({ db, handlers: { requestOtp: () => (++n === 1 ? { ok: true } : { ok: false, status: 429, message: '请 40 秒后再试', retrySec: 40 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  db.failNextWrite(new Error('disk'));
  await flow.inputCode('481203');
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.step, flow.state.error], ['email', '请 40 秒后再试']);
});

test('换账号按取消后再送同一邮箱 → 真的重寄（那组验证码已用掉）', async () => {
  const db = createMemoryDb();
  const { flow, store, calls } = setup({ db, hasLocalData: () => true, confirmSwitch: async () => false, handlers: { verifyOtp: () => ({ ok: true, session: session('u-B') }) } });
  await saveLastUserId(store, 'u-A');
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  db.failNextWrite(new Error('disk')); // 让 clearPending 失败，pending 还留着
  await flow.inputCode('481203');
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(calls.requestOtp.length, 2);
});

test('editField：改动出错的栏位 → 错误清掉（序号不变，不会重念）；改别的栏位不清', async () => {
  const { flow } = setup();
  await flow.start();
  flow.goEmail();
  await flow.submitEmail('abc', '');
  assert.equal(flow.state.error, '请输入正确的邮箱');
  assert.equal(flow.state.errorField, 'email');
  const seq = flow.state.errorSeq;
  flow.editField('invite');
  assert.equal(flow.state.error, '请输入正确的邮箱');
  flow.editField('email');
  assert.equal(flow.state.error, '');
  assert.equal(flow.state.errorField, null);
  assert.equal(flow.state.errorSeq, seq);
});

test('editField：没有对应栏位的错误（网络错）不会被清掉', async () => {
  const { flow } = setup({ handlers: { registerEmail: () => ({ ok: false, message: NET }) } });
  await flow.start();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.error, NET);
  flow.editField('email');
  flow.editField('invite');
  assert.equal(flow.state.error, NET);
});

test('editField：邀请码错误只在改邀请码时清掉', async () => {
  const { flow } = setup({ handlers: { registerEmail: () => ({ ok: false, message: '需要有效的邀请码' }) } });
  await flow.start();
  flow.goEmail();
  await flow.submitEmail('me@x.com', 'XXXX');
  assert.equal(flow.state.errorField, 'invite');
  flow.editField('email');
  assert.equal(flow.state.error, '需要有效的邀请码');
  flow.editField('invite');
  assert.equal(flow.state.error, '');
});

test('editField：「还没注册」改邮箱或改邀请码都会清掉', async () => {
  for (const field of ['email', 'invite']) {
    const { flow } = setup({ handlers: { registerEmail: () => ({ ok: false, message: '这个邮箱还没注册，请填邀请码' }) } });
    await flow.start();
    flow.goEmail();
    await flow.submitEmail('me@x.com', '');
    assert.equal(flow.state.errorField, 'invite');
    flow.editField(field);
    assert.equal(flow.state.error, '', field);
  }
});

test('editField：没有错误时不 emit（不会每个按键都重画）', async () => {
  const { flow } = setup();
  await flow.start();
  flow.goEmail();
  let n = 0;
  flow.subscribe(() => { n += 1; });
  flow.editField('email');
  flow.editField('invite');
  assert.equal(n, 0);
});

test('editField：送出中是空操作；结果回来的错误照常出现、序号加一', async () => {
  const d = deferred();
  const { flow } = setup({ handlers: { registerEmail: () => d.p } });
  await flow.start();
  flow.goEmail();
  const seq = flow.state.errorSeq;
  const p = flow.submitEmail('me@x.com', 'XXXX');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(flow.state.busy, 'send');
  flow.editField('invite');
  d.resolve({ ok: false, message: '需要有效的邀请码' });
  await p;
  assert.equal(flow.state.error, '需要有效的邀请码');
  assert.equal(flow.state.errorSeq, seq + 1);
});

test('editField：清掉后再犯同样的错 → 序号加一（会重念、重新聚焦）；提示不受影响', async () => {
  const { flow, store } = setup();
  await savePending(store, { email: 'me@x.com', sentAt: T0 - 601_000 });
  await flow.start();
  assert.equal(flow.state.notice, '验证码已过期，请重新发送');
  const noticeSeq = flow.state.noticeSeq;
  await flow.submitEmail('abc', '');
  const seq = flow.state.errorSeq;
  flow.editField('email');
  assert.equal(flow.state.error, '');
  assert.equal(flow.state.noticeSeq, noticeSeq);
  await flow.submitEmail('abc', '');
  assert.equal(flow.state.error, '请输入正确的邮箱');
  assert.equal(flow.state.errorSeq, seq + 1);
});
