// 2d：登录 API 调用、中文错误讯息、输入清理（js/auth.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeEmailInput, cleanCode, authErrorMessage, registerEmail, requestOtp, verifyOtp, toSession,
} from '../js/auth.js';
import { SUPABASE_URL, SUPABASE_KEY, REGISTER_URL } from '../js/config.js';
import { normalizeEmail } from '../supabase/functions/_shared/normalize.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const NET = '连不上网络，请检查后再试';
const NOW = Date.parse('2026-11-23T10:00:00Z');

// 假 fetch：handler(url, init, body) → Response；记录每次调用
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(String(url), init);
  };
  f.calls = calls;
  return f;
}
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const okSession = { access_token: 'a.b.c', refresh_token: 'r1', expires_in: 3600, expires_at: 1795000000, user: { id: 'u-1', email: 'me@x.com' } };

// ---------- 输入清理 ----------
test('cleanCode：只留数字、取前 6 个', () => {
  assert.equal(cleanCode('481 203'), '481203');
  assert.equal(cleanCode('481-2039'), '481203');
  assert.equal(cleanCode('ab'), '');
  assert.equal(cleanCode(''), '');
  assert.equal(cleanCode(undefined), '');
});

test('normalizeEmailInput 与服务器 normalizeEmail 用同一组例子，结果相同', () => {
  const cases = JSON.parse(readFileSync(join(root, 'tests/email-cases.json'), 'utf8'));
  for (const [input, want] of cases) {
    assert.equal(normalizeEmailInput(input), want, JSON.stringify(input));
    assert.equal(normalizeEmail(input), want, `服务器：${JSON.stringify(input)}`);
  }
  assert.equal(normalizeEmailInput('a@' + 'x'.repeat(260) + '.com'), '');
  assert.equal(normalizeEmailInput(undefined), '');
});

// ---------- 设定 ----------
test('config：网址与 publishable key', () => {
  assert.equal(SUPABASE_URL, 'https://xzsjdqtrdfbiotypooet.supabase.co');
  assert.match(SUPABASE_KEY, /^sb_publishable_/);
  assert.equal(REGISTER_URL, `${SUPABASE_URL}/functions/v1/register`);
});

// ---------- 请求格式 ----------
test('requestOtp：body 带 create_user:false；header 只有 apikey，没有 Authorization', async () => {
  const f = fakeFetch(() => jsonRes(200, {}));
  const r = await requestOtp(f, 'me@x.com');
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${SUPABASE_URL}/auth/v1/otp`);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(f.calls[0].body, { email: 'me@x.com', create_user: false });
  const h = new Headers(f.calls[0].init.headers);
  assert.equal(h.get('apikey'), SUPABASE_KEY);
  assert.equal(h.get('authorization'), null);
  assert.match(h.get('content-type'), /application\/json/);
});

test('registerEmail：邀请码空白时不带 invite_code；有填时原样送', async () => {
  const f = fakeFetch(() => jsonRes(200, { ok: true }));
  assert.deepEqual(await registerEmail(f, 'me@x.com', '   '), { ok: true });
  assert.deepEqual(f.calls[0].body, { email: 'me@x.com' });
  assert.equal(f.calls[0].url, REGISTER_URL);
  await registerEmail(f, 'me@x.com', 'k7mp-q4xz');
  assert.deepEqual(f.calls[1].body, { email: 'me@x.com', invite_code: 'k7mp-q4xz' });
});

test('registerEmail：403 → 原样中文讯息', async () => {
  const f = fakeFetch(() => jsonRes(403, { error: '需要有效的邀请码' }));
  const r = await registerEmail(f, 'me@x.com', '');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.message, '需要有效的邀请码');
});

test('verifyOtp：body {type:email, email, token}；200 → session', async () => {
  const f = fakeFetch(() => jsonRes(200, okSession));
  const r = await verifyOtp(f, 'me@x.com', '481203', NOW);
  assert.equal(f.calls[0].url, `${SUPABASE_URL}/auth/v1/verify`);
  assert.deepEqual(f.calls[0].body, { type: 'email', email: 'me@x.com', token: '481203' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.session, {
    access_token: 'a.b.c', refresh_token: 'r1', expires_at: NOW + 3600 * 1000, // 优先「现在 + expires_in」
    user_id: 'u-1', email: 'me@x.com', platform: 'pwa',
  });
});

test('verifyOtp：200 但缺 refresh_token 或缺 user.id → 失败', async () => {
  for (const bad of [{ ...okSession, refresh_token: undefined }, { ...okSession, user: {} }]) {
    const r = await verifyOtp(fakeFetch(() => jsonRes(200, bad)), 'me@x.com', '481203', NOW);
    assert.equal(r.ok, false);
    assert.equal(typeof r.message, 'string');
  }
});

test('verifyOtp：403 otp_expired（实测回应）→「验证码不对或已过期」', async () => {
  const f = fakeFetch(() => jsonRes(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }));
  const r = await verifyOtp(f, 'me@x.com', '123456', NOW);
  assert.deepEqual([r.ok, r.message], [false, '验证码不对或已过期']);
});

test('toSession：只有 expires_at 时用它（秒→毫秒）；都没有用 1 小时', () => {
  assert.equal(toSession({ access_token: 'a', refresh_token: 'r', expires_at: 1795000000, user: { id: 'u' } }, 'me@x.com', NOW).expires_at, 1795000000 * 1000);
  assert.equal(toSession({ access_token: 'a', refresh_token: 'r', user: { id: 'u' } }, 'me@x.com', NOW).expires_at, NOW + 3600 * 1000);
});

test('toSession：没有 expires_at 用 expires_in；没有 user.email 用输入的邮箱', () => {
  const s = toSession({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u' } }, 'me@x.com', NOW);
  assert.equal(s.expires_at, NOW + 3600 * 1000);
  assert.equal(s.email, 'me@x.com');
  assert.throws(() => toSession({ refresh_token: 'r', user: { id: 'u' } }, 'me@x.com', NOW));
  assert.throws(() => toSession(null, 'me@x.com', NOW));
});

// ---------- 网络错误与超时 ----------
test('fetch 被拒（离线）→ 网络讯息', async () => {
  const f = async () => { throw new TypeError('Load failed'); };
  for (const r of [await requestOtp(f, 'me@x.com'), await registerEmail(f, 'me@x.com', ''), await verifyOtp(f, 'me@x.com', '123456', NOW)]) {
    assert.deepEqual([r.ok, r.message], [false, NET]);
  }
});

test('超过 timeoutMs 没回应 → 中止请求、网络讯息', async () => {
  let aborted = false;
  const f = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); });
  });
  const r = await requestOtp(f, 'me@x.com', { timeoutMs: 20 });
  assert.equal(aborted, true);
  assert.deepEqual([r.ok, r.message], [false, NET]);
});

test('环境没有 AbortSignal.timeout（iOS 15）时照样能发请求', async () => {
  const saved = AbortSignal.timeout;
  AbortSignal.timeout = undefined;
  try {
    const r = await requestOtp(fakeFetch(() => jsonRes(200, {})), 'me@x.com');
    assert.deepEqual(r, { ok: true });
  } finally { AbortSignal.timeout = saved; }
});

test('回应不是 JSON → 按状态码给讯息，不会 throw', async () => {
  const f = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
  const r = await requestOtp(f, 'me@x.com');
  assert.deepEqual([r.ok, r.message], [false, '服务器暂时有问题，请稍后再试']);
});

test('requestOtp 失败时带 errorCode 与 retrySec（给「验证码刚才已寄出」判断用）', async () => {
  const f = fakeFetch(() => jsonRes(429, { code: 429, error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' }));
  const r = await requestOtp(f, 'me@x.com');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'over_email_send_rate_limit');
  assert.equal(r.retrySec, 42);
  assert.equal(r.message, '请 42 秒后再试');
  const g = fakeFetch(() => jsonRes(429, { code: 429, msg: '请 17 秒后再试' }));
  assert.equal((await requestOtp(g, 'me@x.com')).retrySec, 17);
});

// ---------- authErrorMessage 每条规则 ----------
test('authErrorMessage：规则 1 网络', () => {
  assert.equal(authErrorMessage(0, null, 'otp'), NET);
});

test('authErrorMessage：规则 2 register 只原样显示已知的中文句子', () => {
  for (const m of ['邮箱格式不对', '需要有效的邀请码', '尝试太多次，请稍后再试', '暂时无法注册，请稍后再试']) {
    assert.equal(authErrorMessage(400, { error: m }, 'register'), m);
  }
  assert.equal(authErrorMessage(500, { error: 'Internal Server Error' }, 'register'), '服务器暂时有问题，请稍后再试');
  assert.equal(authErrorMessage(403, { error: 'Forbidden' }, 'register'), '出了点问题，请稍后再试');
});

test('authErrorMessage：规则 3 Auth 自己的 60 秒限制', () => {
  const body = { error_code: 'over_email_send_rate_limit', msg: 'For security purposes, you can only request this after 42 seconds.' };
  assert.equal(authErrorMessage(429, body, 'otp'), '请 42 秒后再试');
  assert.equal(authErrorMessage(429, { error_code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' }, 'otp'), '请稍后再试');
});

test('authErrorMessage：规则 4 钩子的中文讯息 → 抓数字自己组句', () => {
  assert.equal(authErrorMessage(429, { code: 429, msg: '已达到上限，请 37 分钟后再试' }, 'otp'), '已达到上限，请 37 分钟后再试');
  assert.equal(authErrorMessage(429, { code: 429, msg: '请 9 秒后再试' }, 'otp'), '请 9 秒后再试');
  assert.equal(authErrorMessage(429, { msg: '今天的验证码已达上限，请明天再试' }, 'otp'), '今天的验证码已达上限，请明天再试');
  assert.equal(authErrorMessage(429, { msg: '这个邮箱今天已寄太多次验证码，请明天再试' }, 'otp'), '这个邮箱今天已寄太多次验证码，请明天再试');
  // 数字太长、或夹带其他内容 → 不照抄
  assert.equal(authErrorMessage(429, { msg: '请 123456 秒后再试' }, 'otp'), '尝试太多次，请稍后再试');
});

test('authErrorMessage：Task 0 实测的真实回应（钩子改回 200+error 后，2026-11-23）', () => {
  const body = { code: 429, error_code: 'unknown', msg: '已达到上限，请 54 分钟后再试' };
  assert.equal(authErrorMessage(429, body, 'otp'), '已达到上限，请 54 分钟后再试');
});

test('authErrorMessage：规则 5–9', () => {
  assert.equal(authErrorMessage(429, { msg: 'Too many requests' }, 'verify'), '尝试太多次，请稍后再试');
  assert.equal(authErrorMessage(400, {}, 'verify'), '验证码不对或已过期');
  assert.equal(authErrorMessage(401, {}, 'verify'), '验证码不对或已过期');
  assert.equal(authErrorMessage(422, { error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }, 'otp'), '这个邮箱还没注册，请填邀请码');
  assert.equal(authErrorMessage(500, { error_code: 'unexpected_failure', msg: 'Service currently unavailable due to hook' }, 'otp'), '服务器暂时有问题，请稍后再试');
  assert.equal(authErrorMessage(503, {}, 'otp'), '服务器暂时有问题，请稍后再试');
  assert.equal(authErrorMessage(418, {}, 'otp'), '出了点问题，请稍后再试');
  assert.equal(authErrorMessage(400, null, 'otp'), '出了点问题，请稍后再试');
});

// ---------- 安全静态检查 ----------
function jsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? jsFiles(p) : (n.endsWith('.js') ? [p] : []);
  });
}

test('前端 js/ 没有 secret key、service_role；Authorization 只能带变量（用户自己的 token），不能写死', () => {
  for (const f of jsFiles(join(root, 'js'))) {
    const s = readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /sb_secret_|service_role/i, f);
    for (const m of s.matchAll(/authorization/gi)) {
      const x = /^Authorization: `Bearer \$\{([A-Za-z_.]+)\}`/.exec(s.slice(m.index, m.index + 60));
      assert.ok(x, f);
      assert.doesNotMatch(x[1], /^[A-Z_]+$|SUPABASE|KEY/, f); // 不能是 config 常数（publishable key 不是 Bearer）
    }
  }
});

test('auth.js 不把回应或 session 印到 console', () => {
  const s = readFileSync(join(root, 'js/auth.js'), 'utf8');
  assert.doesNotMatch(s, /console\.log\(/);
  for (const m of s.matchAll(/console\.(?:warn|error|info)\(([^)]*)\)/g)) {
    assert.doesNotMatch(m[1], /body|session|token|res\b|json|data/i, m[0]);
  }
});

// ---------- Task 2：session / pending / lastUserId 存本机 ----------
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import {
  loadSession, saveSession, clearSession, loadPending, savePending, clearPending,
  loadLastUserId, saveLastUserId, OTP_TTL_MS, RESEND_MS,
} from '../js/auth.js';

const SESSION = { access_token: 'a', refresh_token: 'r', expires_at: NOW + 3600e3, user_id: 'u-1', email: 'me@x.com', platform: 'pwa' };

test('常数：验证码 10 分钟有效、60 秒后可重发', () => {
  assert.equal(OTP_TTL_MS, 600_000);
  assert.equal(RESEND_MS, 60_000);
});

test('session：存、读、清；栏位不完整当没有', async () => {
  const db = createMemoryDb();
  const store = createStore({ db });
  assert.equal(await loadSession(store), null);
  await saveSession(store, SESSION);
  assert.deepEqual(await loadSession(store), SESSION);
  await clearSession(store);
  assert.equal(await loadSession(store), null);
  await store.setMeta('session', { access_token: 'a' });
  assert.equal(await loadSession(store), null);
});

test('pending：存、读（标出是否过期）、清', async () => {
  const store = createStore({ db: createMemoryDb() });
  assert.equal(await loadPending(store, NOW), null);
  await savePending(store, { email: 'me@x.com', sentAt: NOW - 30_000 });
  assert.deepEqual(await loadPending(store, NOW), { email: 'me@x.com', sentAt: NOW - 30_000, expired: false });
  assert.equal((await loadPending(store, NOW + OTP_TTL_MS)).expired, true);
  await clearPending(store);
  assert.equal(await loadPending(store, NOW), null);
  await store.setMeta('loginPending', { email: 'me@x.com' });
  assert.equal(await loadPending(store, NOW), null);
});

test('lastUserId：存、读', async () => {
  const store = createStore({ db: createMemoryDb() });
  assert.equal(await loadLastUserId(store), null);
  await saveLastUserId(store, 'u-1');
  assert.equal(await loadLastUserId(store), 'u-1');
});
