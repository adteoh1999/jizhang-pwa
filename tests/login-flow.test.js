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
  const calls = { registerEmail: [], requestOtp: [], verifyOtp: [], discardSession: [] };
  const api = {
    registerEmail: (...a) => { calls.registerEmail.push(a); return (handlers.registerEmail || (() => ({ ok: true })))(...a); },
    requestOtp: (...a) => { calls.requestOtp.push(a); return (handlers.requestOtp || (() => ({ ok: true })))(...a); },
    verifyOtp: (...a) => { calls.verifyOtp.push(a); return (handlers.verifyOtp || (() => ({ ok: true, session: session() })))(...a); },
    discardSession: (...a) => { calls.discardSession.push(a); return Promise.resolve(); },
  };
  return { api, calls };
}

function setup({ handlers, nowRef = { t: T0 }, db = createMemoryDb(), confirmReset = async () => true, store = createStore({ db }), onReset, telegram } = {}) {
  const { api, calls } = fakeApi(handlers);
  const signed = [];
  const switches = [];
  const flow = createLoginFlow({
    api, store, now: () => nowRef.t,
    confirmReset: async (info) => { switches.push(info); return confirmReset(info); },
    onSignedIn: (s) => signed.push(s),
    onReset,
    telegram,
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

// R1-11（3b-1 实测：Telegram 的 generate_link 也会占用 60 秒限制，但不寄信）：
// 只有这个流程 60 秒内对同一邮箱送过 requestOtp、或本机有同邮箱的 pending，才说「验证码刚才已寄出」
test('R1-11：otp 回「刚寄过」但这里没寄过、本机也没 pending → 留在邮箱页显示秒数', async () => {
  const { flow, store } = setup({ handlers: { requestOtp: () => ({ ok: false, status: 429, message: '请 45 秒后再试', retrySec: 45 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.deepEqual([flow.state.step, flow.state.error], ['email', '请 45 秒后再试']);
  assert.equal(await loadPending(store, T0), null);
});

test('R1-11：上一次送出超时（其实可能寄出了）、60 秒内再送同一邮箱回「刚寄过」→ 进验证码页，提示刚才已寄出', async () => {
  let n = 0;
  const { flow, store, nowRef } = setup({ handlers: { requestOtp: () => (++n === 1 ? { ok: false, status: 0, message: NET } : { ok: false, status: 429, message: '请 42 秒后再试', retrySec: 42 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'email');
  nowRef.t += 18_000;
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'code');
  assert.equal(flow.state.notice, '验证码刚才已寄出');
  assert.equal(flow.resendLeft(), 42);
  assert.equal((await loadPending(store, nowRef.t)).email, 'me@x.com');
});

test('R1-11：送过的是别的邮箱、或已超过 60 秒 → 不算刚寄过', async () => {
  for (const [first, wait] of [['other@x.com', 5_000], ['me@x.com', 61_000]]) {
    let n = 0;
    const { flow, nowRef } = setup({ handlers: { requestOtp: () => (++n === 1 ? { ok: false, status: 0, message: NET } : { ok: false, status: 429, message: '请 30 秒后再试', retrySec: 30 }) } });
    flow.goEmail();
    await flow.submitEmail(first, '');
    nowRef.t += wait;
    await flow.submitEmail('me@x.com', '');
    assert.deepEqual([flow.state.step, flow.state.error], ['email', '请 30 秒后再试'], `${first} ${wait}`);
  }
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
  // R1-11：要本机刚送过才进验证码页 → 第一次送出超时，第二次回 90 秒
  let n = 0;
  const { flow } = setup({ handlers: { requestOtp: () => (++n === 1 ? { ok: false, status: 0, message: NET } : { ok: false, status: 429, message: '请 90 秒后再试', retrySec: 90 }) } });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.submitEmail('me@x.com', '');
  assert.equal(flow.state.step, 'code');
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
  const { flow, store, calls } = setup({ db, confirmReset: async () => false, handlers: { verifyOtp: () => ({ ok: true, session: session('u-B') }) } });
  await saveLastUserId(store, 'u-A');
  await store.init();
  await store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
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

// ---------- 2e 任务 4（审核 M2）：换账号前先记下本地账本属于谁 ----------
async function withMetaReadFailing(store, key, fn) {
  const real = store.getMeta;
  store.getMeta = async (k) => { if (k === key) throw new Error('idb'); return real(k); };
  const orig = console.warn;
  console.warn = () => {};
  try { await fn(); } finally { console.warn = orig; store.getMeta = real; }
}

test('读 lastUserId 或 owner 失败 → 不登录（不当成「没有上一个账号」）', async () => {
  for (const key of ['lastUserId', 'owner_user_id']) {
    const { flow, store, signed } = setup({ handlers: { verifyOtp: () => ({ ok: true, session: session('u-B') }) } });
    await saveLastUserId(store, 'u-A');
    flow.goEmail();
    await flow.submitEmail('me@x.com', '');
    await withMetaReadFailing(store, key, () => flow.inputCode('481203'));
    assert.equal(signed.length, 0, key);
    assert.equal(await loadSession(store), null, key);
    assert.equal(flow.state.error, '登录资料没存好，请重新发送验证码', key);
  }
});


// ---------- 2e-2 任务 9（spec §7.7、审核 M5）：换账号清除本地账本 ----------
const B = () => ({ handlers: { verifyOtp: () => ({ ok: true, session: session('u-B') }) } });
const tx = (store, o = {}) => store.saveTransaction({ kind: 'expense', amountMinor: 1, categoryId: 'food', occurredOn: '2026-11-20', note: '', ...o });
async function login(flow) {
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  await flow.inputCode('481203');
}
async function prep(store, { owner, last, txs = 0, synced = false }) {
  await store.init();
  for (let i = 0; i < txs; i++) await tx(store, { amountMinor: 1 + i });
  if (synced) {
    await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
    await store.markUploaded('categories', await store.pendingRows('categories'), []);
  }
  const meta = {};
  if (owner) meta.owner_user_id = owner;
  if (last) meta.lastUserId = last;
  meta['cursor:transactions'] = { ts: 'T', id: 'I' };
  await store.setMetas(meta);
}

test('换账号：账本属于 A、有 2 笔还没上传、B 登录 → 先问（带笔数）；同意 → 清掉、owner/session/lastUserId 是 B、默认分类 10 个、游标清掉', async () => {
  const { flow, store, signed, switches } = setup(B());
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 2 });
  await login(flow);
  assert.deepEqual(switches, [{ txCount: 2 }]);
  assert.equal(signed.length, 1);
  assert.equal(store.transactions().length, 0);
  assert.equal(store.categories('expense').length + store.categories('income').length, 10);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
  assert.equal((await loadSession(store)).user_id, 'u-B');
  assert.equal(await loadLastUserId(store), 'u-B');
  assert.equal(await store.getMeta('cursor:transactions'), null);
  assert.equal(await loadPending(store, T0), null);
});

test('换账号：不同意 → 不存 session、回欢迎页、账本与 owner 都还在', async () => {
  const { flow, store, signed, switches } = setup({ ...B(), confirmReset: async () => false });
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 1 });
  await login(flow);
  assert.equal(switches.length, 1);
  assert.equal(signed.length, 0);
  assert.equal(await loadSession(store), null);
  assert.equal(flow.state.step, 'welcome');
  assert.equal(store.transactions().length, 1);
  assert.equal(await store.getMeta('owner_user_id'), 'u-A');
  assert.equal(await loadLastUserId(store), 'u-A');
});

test('换账号：A 的账全部已上传 → 不问、直接清掉、B 登录', async () => {
  const { flow, store, signed, switches } = setup(B());
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 3, synced: true });
  await login(flow);
  assert.equal(switches.length, 0);
  assert.equal(signed.length, 1);
  assert.equal(store.transactions().length, 0);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
});

test('换账号：没有 owner（还没开始同步）、上次 A、本地有账 → 全部算没上传，问（笔数是看得到的账）', async () => {
  const { flow, store, switches } = setup(B());
  await prep(store, { last: 'u-A', txs: 2 });
  await login(flow);
  assert.deepEqual(switches, [{ txCount: 2 }]);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
});

test('换账号：只剩已删除的账或自建分类还没上传 → 照样问（txCount 只数还没上传的账目）', async () => {
  for (const kind of ['deletedTx', 'customCat']) {
    const { flow, store, switches } = setup(B());
    await prep(store, { owner: 'u-A', last: 'u-A', synced: true });
    if (kind === 'deletedTx') { const t = await tx(store); await store.deleteTransaction(t.id); } else { await store.saveCategory({ kind: 'expense', name: '宠物' }); }
    await login(flow);
    assert.deepEqual(switches, [{ txCount: 0 }], kind); // S-8：N 只数看得到的账
  }
});

test('同一个账号、或本地从没登录过 → 不问、不清', async () => {
  for (const [owner, last] of [['u-1', 'u-1'], [null, null], [null, 'u-1'], ['u-1', 'u-B']]) {
    const { flow, store, signed, switches } = setup();
    await prep(store, { owner, last, txs: 1 });
    await login(flow);
    assert.equal(switches.length, 0, `${owner} ${last}`);
    assert.equal(signed.length, 1, `${owner} ${last}`);
    assert.equal(store.transactions().length, 1, `${owner} ${last}`);
  }
});

test('换账号：账本主人是 A、lastUserId 是自己 → 照样问', async () => {
  const { flow, store, switches } = setup();
  await prep(store, { owner: 'u-A', last: 'u-1', txs: 1 });
  await login(flow);
  assert.equal(switches.length, 1);
});

test('换账号：清除写入失败 → 不登录、账本 / owner / session / lastUserId 都没变', async () => {
  const db = createMemoryDb();
  const { flow, store, signed } = setup({ db, ...B() });
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 1 });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  const real = store.resetForAccount;
  store.resetForAccount = (...a) => { db.failNextWrite(new Error('disk')); return real(...a); };
  const orig = console.warn;
  console.warn = () => {};
  try { await flow.inputCode('481203'); } finally { console.warn = orig; }
  assert.equal(signed.length, 0);
  assert.equal(await loadSession(store), null);
  assert.equal(store.transactions().length, 1);
  assert.equal(await store.getMeta('owner_user_id'), 'u-A');
  assert.equal(await loadLastUserId(store), 'u-A');
  assert.equal(flow.state.error, '登录资料没存好，请重新发送验证码');
});

// ---------- 任务 9 审核修正 ----------
test('审核 S-2：B 的默认分类还没传上去就换回 A → 不问（没改过的默认分类不算）', async () => {
  const { flow, store, switches, signed } = setup();
  await prep(store, { owner: 'u-B', last: 'u-B', synced: true });
  await store.resetForAccount('u-B'); // 默认分类 dirty 1
  await login(flow);
  assert.equal(switches.length, 0);
  assert.equal(signed.length, 1);
});

test('审核 S-3：对话框开着（验证中）时 checkExpiry 不把页面切走', async () => {
  const nowRef = { t: T0 };
  let flowRef;
  const { flow, store } = setup({ ...B(), nowRef, confirmReset: async () => { nowRef.t += 11 * 60_000; assert.equal(flowRef.checkExpiry(), false); assert.equal(flowRef.state.step, 'code'); return false; } });
  flowRef = flow;
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 1 });
  await login(flow);
  assert.equal(flow.state.step, 'welcome');
});

test('审核 S-4：要弹对话框前就清掉 pending（码已用掉）', async () => {
  let seen = 'x';
  const box = {};
  const { flow, store } = setup({ ...B(), confirmReset: async () => { seen = await loadPending(box.store, T0); return false; } });
  box.store = store;
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 1 });
  await login(flow);
  assert.equal(seen, null);
});

test('审核 S-5：取消登录 → 尽力作废这次的 session', async () => {
  const { flow, store, calls } = setup({ ...B(), confirmReset: async () => false });
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 1 });
  await login(flow);
  assert.equal(calls.discardSession.length, 1);
  assert.equal(calls.discardSession[0][0].user_id, 'u-B');
});

test('清除成功 → onReset 通知（广播给其他分页）；没换账号 → 不通知', async () => {
  let n = 0;
  const a = setup({ ...B(), onReset: () => n++ });
  await prep(a.store, { owner: 'u-A', last: 'u-A', txs: 1, synced: true });
  await login(a.flow);
  assert.equal(n, 1);
  const b = setup({ onReset: () => n++ });
  await prep(b.store, { owner: 'u-1', last: 'u-1' });
  await login(b.flow);
  assert.equal(n, 1);
});

test('审核 M-1：别的分页之后记的账 → 登录时重新载入、算进去、要问', async () => {
  const db = createMemoryDb();
  const store1 = createStore({ db });
  await prep(store1, { owner: 'u-A', last: 'u-A', synced: true });
  const store2 = createStore({ db });
  await store2.init();
  await tx(store2, { amountMinor: 9 });
  const { flow, switches } = setup({ ...B(), db, store: store1 });
  await login(flow);
  assert.deepEqual(switches, [{ txCount: 1 }]);
});

test('审核 M-1：别的分页已清除成 B，这个分页（旧快取有 A 的账）再用 B 登录 → 快取重新载入、A 的账不会传到 B', async () => {
  const db = createMemoryDb();
  const store1 = createStore({ db });
  await prep(store1, { owner: 'u-A', last: 'u-A', txs: 2 });
  const store2 = createStore({ db });
  await store2.init();
  await store1.resetForAccount('u-B', { meta: { lastUserId: 'u-B' } });
  const { flow, signed } = setup({ ...B(), db, store: store2 });
  await login(flow);
  assert.equal(signed.length, 1);
  assert.equal(store2.transactions().length, 0);
  assert.equal((await store2.pendingRows('transactions')).length, 0);
});

test('复审 8：验证成功但重新载入失败 → 不登录、尽力作废 session', async () => {
  const { flow, store, calls, signed } = setup(B());
  await prep(store, { owner: 'u-A', last: 'u-A' });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  store.init = async () => { throw new Error('idb'); };
  const orig = console.warn;
  console.warn = () => {};
  try { await flow.inputCode('481203'); } finally { console.warn = orig; }
  assert.equal(signed.length, 0);
  assert.equal(calls.discardSession.length, 1);
});


// ---------- 3b-8：Telegram 模式的「连接」步骤（R1）、事前检查 ----------
const SEC = (ms) => Math.floor(ms / 1000);
function tg({ link = async () => ({ ok: true, data: { result: 'linked' } }), authDate = SEC(T0) - 60, bindDeadline = null, label = '@zed', status = async () => ({ ok: true, data: { linked: false, label: '' } }), tgId = '987654321' } = {}) {
  const tc = { link: [], stale: 0, status: [], uncertain: [] };
  const telegram = {
    tgId, label, authDate, bindDeadline,
    link: async (s) => { tc.link.push(s); return link(s); },
    status: async (s) => { tc.status.push(s); return status(s); },
    onInitStale: () => { tc.stale += 1; },
    onCancelUncertain: (linked) => { tc.uncertain.push(linked); },
  };
  return { telegram, tc };
}
function spyMetas(store) {
  const seen = [];
  const orig = store.setMetas.bind(store);
  store.setMetas = (m, ...rest) => { seen.push(Object.keys(m).sort()); return orig(m, ...rest); };
  return seen;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('Telegram：验证成功后先不存 session，进「连接」步骤（带邮箱与名字），pending 清掉', async () => {
  const { telegram, tc } = tg();
  const { flow, store, signed } = setup({ telegram });
  await login(flow);
  assert.equal(flow.state.step, 'link');
  assert.equal(flow.state.linkEmail, 'me@x.com');
  assert.equal(flow.state.linkLabel, '@zed');
  assert.equal(await loadSession(store), null);
  assert.equal(await loadPending(store, T0), null);
  assert.equal(signed.length, 0);
  assert.equal(tc.link.length, 0);
});

test('Telegram：按「连接」成功 → 一次 setMetas 写入 session、lastUserId、tgId → onSignedIn', async () => {
  const { telegram, tc } = tg();
  const { flow, store, signed } = setup({ telegram });
  await login(flow);
  const seen = spyMetas(store);
  await flow.confirmLink();
  assert.equal(tc.link.length, 1);
  assert.equal(tc.link[0].user_id, 'u-1');
  assert.deepEqual(seen, [['lastUserId', 'session', 'tgId']]);
  assert.equal((await loadSession(store)).user_id, 'u-1');
  assert.equal(await store.getMeta('tgId'), '987654321');
  assert.equal(flow.state.step, 'done');
  assert.equal(signed.length, 1);
});

test('Telegram：换账号（已确认清除）→ 连接成功才 resetForAccount（meta 含 tgId）、onReset', async () => {
  const { telegram } = tg();
  const resets = [];
  const { flow, store, signed } = setup({ ...B(), telegram, onReset: () => resets.push(1) });
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 2 });
  await login(flow);
  assert.equal(flow.state.step, 'link');
  assert.equal(store.transactions().length, 2, '连接前不清');
  await flow.confirmLink();
  assert.equal(store.transactions().length, 0);
  assert.equal(await store.getMeta('owner_user_id'), 'u-B');
  assert.equal(await store.getMeta('tgId'), '987654321');
  assert.equal(resets.length, 1);
  assert.equal(signed.length, 1);
});

test('Telegram：user_taken → 作废 session、不存、本地账不动、回邮箱页显示服务器句子', async () => {
  const msg = '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接';
  const { telegram } = tg({ link: async () => ({ ok: false, status: 409, code: 'user_taken', error: msg, retry: false }) });
  const { flow, store, calls, signed } = setup({ ...B(), telegram });
  await prep(store, { owner: 'u-A', last: 'u-A', txs: 2 });
  await login(flow);
  await flow.confirmLink();
  await flush();
  assert.equal(calls.discardSession.length, 1);
  assert.equal(await loadSession(store), null);
  assert.equal(store.transactions().length, 2);
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.error, msg);
  assert.equal(signed.length, 0);
});

test('Telegram：init_stale → 作废 session、onInitStale 一次、不回邮箱页', async () => {
  const { telegram, tc } = tg({ link: async () => ({ ok: false, status: 422, code: 'init_stale', error: '太久没有完成，请关掉再重新打开', retry: false }) });
  const { flow, store, calls } = setup({ telegram });
  await login(flow);
  await flow.confirmLink();
  await flush();
  assert.equal(calls.discardSession.length, 1);
  assert.equal(tc.stale, 1);
  assert.notEqual(flow.state.step, 'email');
  assert.equal(await loadSession(store), null);
});

test('Telegram：retry（网络错／busy）→ 留在连接步骤显示错误，再按一次成功', async () => {
  let n = 0;
  const { telegram, tc } = tg({ link: async () => (++n === 1 ? { ok: false, status: 0, code: null, error: '需要网络', retry: true } : { ok: true, data: { result: 'already' } }) });
  const { flow, calls, signed } = setup({ telegram });
  await login(flow);
  await flow.confirmLink();
  assert.equal(flow.state.step, 'link');
  assert.equal(flow.state.error, '需要网络');
  assert.equal(calls.discardSession.length, 0);
  await flow.confirmLink();
  assert.equal(tc.link.length, 2);
  assert.equal(flow.state.step, 'done');
  assert.equal(signed.length, 1);
});

test('Telegram：连接成功但写入失败 → 作废 session、回邮箱页、不登录', async () => {
  const { telegram } = tg();
  const db = createMemoryDb();
  const { flow, store, calls, signed } = setup({ db, telegram });
  await login(flow);
  db.failNextWrite(new Error('disk'));
  await flow.confirmLink();
  await flush();
  assert.equal(calls.discardSession.length, 1);
  assert.equal(await loadSession(store), null);
  assert.equal(flow.state.step, 'email');
  assert.equal(flow.state.error, '登录资料没存好，请关掉后重新打开');
  assert.equal(signed.length, 0);
});

test('Telegram：取消、或在连接步骤按返回 → 作废 session、回欢迎页、本地资料不动', async () => {
  for (const how of ['cancelLink', 'back']) {
    const { telegram } = tg();
    const { flow, store, calls } = setup({ ...B(), telegram });
    await prep(store, { owner: 'u-A', last: 'u-A', txs: 2 });
    await login(flow);
    flow[how]();
    await flush();
    assert.equal(calls.discardSession.length, 1, how);
    assert.equal(flow.state.step, 'welcome', how);
    assert.equal(store.transactions().length, 2, how);
    assert.equal(await loadSession(store), null, how);
    await flow.confirmLink(); // 取消之后按连接没作用
    assert.equal(flow.state.step, 'welcome');
  }
});

test('Telegram：连接中再按一次 → 只叫一次 link', async () => {
  const d = deferred();
  const { telegram, tc } = tg({ link: () => d.p });
  const { flow } = setup({ telegram });
  await login(flow);
  const a = flow.confirmLink();
  assert.equal(flow.state.busy, 'link');
  await flow.confirmLink();
  d.resolve({ ok: true, data: { result: 'linked' } });
  await a;
  assert.equal(tc.link.length, 1);
});

test('Telegram 事前检查：只剩 100 秒 → 送邮箱不叫 register、送验证码不叫 verify（pending 还在），都叫 onInitStale', async () => {
  const { telegram, tc } = tg({ authDate: SEC(T0) - 500 });
  const { flow, store, calls } = setup({ telegram });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal(calls.registerEmail.length, 0);
  assert.equal(tc.stale, 2, 'goEmail 与 submitEmail 各一次');

  const t2 = tg({ authDate: SEC(T0) - 60 });
  const s2 = setup({ telegram: t2.telegram, nowRef: { t: T0 } });
  s2.flow.goEmail();
  await s2.flow.submitEmail('me@x.com', '');
  assert.equal(s2.flow.state.step, 'code');
  s2.nowRef.t += 430_000; // 剩 110 秒
  await s2.flow.inputCode('481203');
  assert.equal(s2.calls.verifyOtp.length, 0);
  assert.equal(t2.tc.stale, 1);
  assert.equal((await loadPending(s2.store, s2.nowRef.t)).email, 'me@x.com');
});

test('Telegram 事前检查：start() 时已不够 → onInitStale，不读 pending 换页', async () => {
  const { telegram, tc } = tg({ authDate: SEC(T0) - 590 });
  const { flow, store } = setup({ telegram });
  await savePending(store, { email: 'me@x.com', sentAt: T0 - 30_000 });
  await flow.start();
  assert.equal(tc.stale, 1);
  assert.notEqual(flow.state.step, 'code');
  assert.equal((await loadPending(store, T0)).email, 'me@x.com', 'pending 保留');
});

test('Telegram 事前检查用 bindDeadline（服务器算的）：手机时钟快 8 分钟也能登录', async () => {
  // 本机时间比真实快 480 秒：用 authDate 算会以为只剩 60 秒；服务器说还剩 540 秒
  const { telegram, tc } = tg({ authDate: SEC(T0) - 540, bindDeadline: T0 + 540_000 });
  const { flow, signed } = setup({ telegram });
  await login(flow);
  await flow.confirmLink();
  assert.equal(tc.stale, 0);
  assert.equal(signed.length, 1);
});

test('Telegram：按「连接」时只剩 5 秒以内 → 不送 bind、作废 session、onInitStale', async () => {
  const { telegram, tc } = tg({ bindDeadline: T0 + 300_000 });
  const { flow, calls, nowRef } = setup({ telegram });
  await login(flow);
  nowRef.t = T0 + 296_000;
  await flow.confirmLink();
  await flush();
  assert.equal(tc.link.length, 0);
  assert.equal(calls.discardSession.length, 1);
  assert.equal(tc.stale, 1);
});

test('PWA（没有 telegram）：没有连接步骤，confirmLink／cancelLink 没作用', async () => {
  const { flow, signed, store } = setup();
  await login(flow);
  assert.equal(flow.state.step, 'done');
  assert.equal(signed.length, 1);
  assert.equal((await store.getMeta('tgId')) ?? null, null);
  await flow.confirmLink();
  flow.cancelLink();
  assert.equal(flow.state.step, 'done');
});


// ---------- 3b 前端审核修正 ----------
test('审核：连接结果不明（retry）之后按取消 → 先问服务器状态；连上了 → onCancelUncertain(true)；问不到 → (null)；没连上 → 不说明', async () => {
  const retry = async () => ({ ok: false, status: 0, code: null, error: '需要网络', retry: true });
  for (const [status, want] of [
    [async () => ({ ok: true, data: { linked: true, label: '@zed' } }), [true]],
    [async () => ({ ok: false, status: 0, code: null, error: '需要网络', retry: true }), [null]],
    [async () => ({ ok: true, data: { linked: false, label: '' } }), []],
  ]) {
    const { telegram, tc } = tg({ link: retry, status });
    const { flow, calls } = setup({ telegram });
    await login(flow);
    await flow.confirmLink();
    await flow.cancelLink();
    await flush();
    assert.equal(tc.status.length, 1);
    assert.equal(tc.status[0].user_id, 'u-1');
    assert.deepEqual(tc.uncertain, want);
    assert.equal(calls.discardSession.length, 1);
    assert.equal(flow.state.step, 'welcome');
  }
});

test('审核：没有结果不明的 bind 就取消 → 不问状态', async () => {
  const { telegram, tc } = tg();
  const { flow } = setup({ telegram });
  await login(flow);
  await flow.cancelLink();
  assert.equal(tc.status.length, 0);
  assert.deepEqual(tc.uncertain, []);
});

test('审核：Telegram 模式的 pending 绑 tgId；换了别的 Telegram 打开 → 清掉 pending、回欢迎页（不显示别人的邮箱）', async () => {
  const a = tg({ tgId: 'A-111' });
  const s1 = setup({ telegram: a.telegram });
  s1.flow.goEmail();
  await s1.flow.submitEmail('me@x.com', '');
  assert.equal((await s1.store.getMeta('loginPending')).tgId, 'A-111');
  const b = tg({ tgId: 'B-222' });
  const s2 = setup({ telegram: b.telegram, store: s1.store, db: s1.db });
  await s2.flow.start();
  assert.equal(s2.flow.state.step, 'welcome');
  assert.equal(s2.flow.state.email, '');
  assert.equal(await loadPending(s1.store, T0), null);
  // 同一个 Telegram 重开 → 照样回验证码页
  const s3 = setup({ telegram: a.telegram });
  s3.flow.goEmail();
  await s3.flow.submitEmail('me@x.com', '');
  const s4 = setup({ telegram: a.telegram, store: s3.store, db: s3.db });
  await s4.flow.start();
  assert.equal(s4.flow.state.step, 'code');
});

test('审核：PWA 的 pending 不存 tgId（行为不变）', async () => {
  const { flow, store } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  assert.equal((await store.getMeta('loginPending')).tgId, undefined);
});

test('审核：重发也做事前检查（剩不到 120 秒不再寄）', async () => {
  const { telegram, tc } = tg({ authDate: SEC(T0) - 60 });
  const { flow, calls, nowRef } = setup({ telegram });
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  nowRef.t += 430_000;
  await flow.resend();
  assert.equal(calls.requestOtp.length, 1);
  assert.equal(tc.stale, 1);
});

test('审核：PWA 存登录资料（setMetas）失败 → 也尽力作废这次的 session', async () => {
  const { flow, calls, store } = setup();
  flow.goEmail();
  await flow.submitEmail('me@x.com', '');
  store.setMetas = async () => { throw new Error('disk'); };
  await flow.inputCode('481203');
  assert.equal(flow.state.error, '登录资料没存好，请重新发送验证码');
  await flush();
  assert.equal(calls.discardSession.length, 1);
});
