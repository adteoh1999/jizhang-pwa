// 3b-7：js/tg-api.js（tg-login、tg-link、tg-admin 的前端客户端）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgLogin, tgLink, tgAdminSetup, tgAdminStatus, tgAdminPause } from '../js/tg-api.js';
import { SUPABASE_KEY, TG_LOGIN_URL, TG_LINK_URL, TG_ADMIN_URL } from '../js/config.js';

const TOKEN = 'eyJ.user-token.sig';
const INIT = 'query_id=x&user=%7B%22id%22%3A1%7D&auth_date=1764000000&hash=ab';
const NOW = 1_764_000_000_000;
const UID = '11111111-1111-4111-8111-111111111111';
const GENERIC = '暂时无法完成，请稍后再试';

function fake(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return handler(url, init); };
  f.calls = calls;
  return f;
}
const res = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), { status });
const hangUntilAbort = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
async function delaysOf(fn) {
  const orig = globalThis.setTimeout;
  const seen = [];
  globalThis.setTimeout = (cb, ms, ...a) => { seen.push(ms); return orig(cb, ms, ...a); };
  try { await fn(); } finally { globalThis.setTimeout = orig; }
  return seen;
}
async function quiet(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return { r: await fn(), logs }; } finally { Object.assign(console, orig); }
}

const LINKED = {
  status: 'linked', access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
  user: { id: UID, email: 'me@example.invalid' }, label: '@zed', extra: 'x',
};

// ---------------- tgLogin ----------------

test('tgLogin：POST tg-login，带 apikey、JSON，不带 Authorization；body 只有 initData', async () => {
  const f = fake(() => res(200, { status: 'stale' }));
  await tgLogin(f, INIT, NOW);
  const c = f.calls[0];
  assert.equal(c.url, TG_LOGIN_URL);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.apikey, SUPABASE_KEY);
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.init.headers.Authorization, undefined);
  assert.deepEqual(c.body, { initData: INIT });
});

test('tgLogin：linked → session 来自 toSession（多余栏位不进 session）、label', async () => {
  const r = await tgLogin(fake(() => res(200, LINKED)), INIT, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'linked');
  assert.equal(r.label, '@zed');
  assert.deepEqual(r.session, {
    access_token: 'AT', refresh_token: 'RT', expires_at: NOW + 3600 * 1000, user_id: UID, email: 'me@example.invalid', platform: 'pwa',
  });
  assert.deepEqual(Object.keys(r).sort(), ['label', 'ok', 'session', 'status']);
});

test('tgLogin：linked 但 session 不完整（含没有邮箱）→ server', async () => {
  for (const over of [{ access_token: '' }, { refresh_token: undefined }, { user: {} }, { user: undefined }, { user: { id: UID } }, { user: { id: UID, email: '' } }]) {
    const { r } = await quiet(() => tgLogin(fake(() => res(200, { ...LINKED, ...over })), INIT, NOW));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.kind, 'server');
  }
});

test('tgLogin：label 不是字串 → 空字串', async () => {
  const r = await tgLogin(fake(() => res(200, { ...LINKED, label: 5 })), INIT, NOW);
  assert.equal(r.label, '');
  const u = await tgLogin(fake(() => res(200, { status: 'unlinked', label: null, bindLeft: 100 })), INIT, NOW);
  assert.equal(u.label, '');
});

test('tgLogin：unlinked → bindDeadline = 本机现在 + bindLeft 秒；bindLeft 不是有限数字 → null', async () => {
  const r = await tgLogin(fake(() => res(200, { status: 'unlinked', label: 'Ann', bindLeft: 500 })), INIT, NOW);
  assert.deepEqual(r, { ok: true, status: 'unlinked', label: 'Ann', bindDeadline: NOW + 500_000 });
  for (const bindLeft of [undefined, '500', null, Infinity, NaN]) {
    const x = await tgLogin(fake(() => res(200, { status: 'unlinked', label: 'Ann', bindLeft })), INIT, NOW);
    assert.equal(x.bindDeadline, null, String(bindLeft));
  }
});

test('tgLogin：stale → {ok:true, status:stale}', async () => {
  assert.deepEqual(await tgLogin(fake(() => res(200, { status: 'stale' })), INIT, NOW), { ok: true, status: 'stale' });
});

test('tgLogin：403 tg_invalid → invalid；429 → limited；句子照白名单', async () => {
  const a = await quiet(() => tgLogin(fake(() => res(403, { code: 'tg_invalid', error: '无法确认 Telegram 身份' })), INIT, NOW));
  assert.deepEqual(a.r, { ok: false, kind: 'invalid', message: '无法确认 Telegram 身份' });
  const b = await quiet(() => tgLogin(fake(() => res(429, { error: '请 1 分钟后再试' })), INIT, NOW));
  assert.deepEqual(b.r, { ok: false, kind: 'limited', message: '请 1 分钟后再试' });
});

test('tgLogin：400、401、其他 403、5xx、2xx 内容不对 → server；白名单外的句子换成通用句', async () => {
  const cases = [
    res(400, { error: '看不懂这个请求' }), res(401, { error: 'Invalid JWT' }), res(403, { error: '<b>假</b>' }),
    res(500, { error: '暂时无法登录，请稍后再试' }), res(502, null), res(200, { status: 'weird' }), new Response('not json', { status: 200 }),
  ];
  for (const c of cases) {
    const { r } = await quiet(() => tgLogin(fake(() => c.clone()), INIT, NOW));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'server', String(c.status));
    assert.ok(['看不懂这个请求', '暂时无法登录，请稍后再试', GENERIC].includes(r.message), r.message);
  }
  const { r } = await quiet(() => tgLogin(fake(() => res(403, { error: '<b>假</b>' })), INIT, NOW));
  assert.equal(r.message, GENERIC);
});

test('tgLogin：网络错、超时 → net「需要网络」；预设超时 15 秒', async () => {
  const a = await quiet(() => tgLogin(async () => { throw new TypeError('x'); }, INIT, NOW));
  assert.deepEqual(a.r, { ok: false, kind: 'net', message: '需要网络' });
  const b = await quiet(() => tgLogin(fake(hangUntilAbort), INIT, NOW, { timeoutMs: 30 }));
  assert.deepEqual(b.r, { ok: false, kind: 'net', message: '需要网络' });
  const seen = await delaysOf(() => tgLogin(fake(() => res(200, { status: 'stale' })), INIT, NOW));
  assert.ok(seen.includes(15000));
});

test('tgLogin：日志只有函数名＋状态码，不含 initData、token', async () => {
  const { logs } = await quiet(() => tgLogin(fake(() => res(500, { error: 'x', access_token: 'AT' })), INIT, NOW));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /tg-login/);
  assert.match(logs[0], /500/);
  assert.ok(!logs[0].includes(INIT) && !logs[0].includes('AT'));
});

// ---------------- tgLink ----------------

test('tgLink：POST tg-link，带 apikey、Bearer、JSON；body {action, initData}；没给 initData 就不送', async () => {
  const f = fake(() => res(200, { result: 'linked' }));
  await tgLink(f, TOKEN, 'bind', { initData: INIT });
  const c = f.calls[0];
  assert.equal(c.url, TG_LINK_URL);
  assert.equal(c.init.headers.apikey, SUPABASE_KEY);
  assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(c.body, { action: 'bind', initData: INIT });
  await tgLink(f, TOKEN, 'status');
  assert.deepEqual(f.calls[1].body, { action: 'status' });
});

test('tgLink：2xx JSON 物件 → {ok:true, data}', async () => {
  assert.deepEqual(await tgLink(fake(() => res(200, { linked: true, label: 'x' })), TOKEN, 'status'), { ok: true, data: { linked: true, label: 'x' } });
});

test('tgLink：各种失败的 code、句子、retry', async () => {
  const cases = [
    [res(422, { code: 'init_stale', error: '太久没有完成，请关掉再重新打开' }), 422, 'init_stale', '太久没有完成，请关掉再重新打开', false],
    [res(403, { code: 'tg_invalid', error: '无法确认 Telegram 身份' }), 403, 'tg_invalid', '无法确认 Telegram 身份', false],
    [res(409, { code: 'telegram_taken', error: '这个 Telegram 已连接另一个邮箱' }), 409, 'telegram_taken', '这个 Telegram 已连接另一个邮箱', false],
    [res(409, { code: 'user_taken', error: '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接' }), 409, 'user_taken', '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接', false],
    [res(503, { code: 'busy', error: '系统忙碌，请再试一次' }), 503, 'busy', '系统忙碌，请再试一次', true],
    [res(401, { error: '请重新登录后再试' }), 401, null, '请重新登录后再试', false],
    [res(403, { error: '没有权限' }), 403, null, '没有权限', false],
    [res(500, { error: '暂时无法连接，请稍后再试' }), 500, null, '暂时无法连接，请稍后再试', true],
    [res(400, { error: '看不懂这个请求' }), 400, null, '看不懂这个请求', false],
    [res(409, { code: 'evil', error: '点这里 evil.com' }), 409, null, GENERIC, false],
    [res(502, null), 502, null, GENERIC, true],
    [res(429, { error: 'x' }), 429, null, GENERIC, true],
  ];
  for (const [r0, status, code, error, retry] of cases) {
    const { r } = await quiet(() => tgLink(fake(() => r0.clone()), TOKEN, 'bind', { initData: INIT }));
    assert.deepEqual(r, { ok: false, status, code, error, retry }, `${status} ${code}`);
  }
});

test('tgLink：2xx 但内容不是 JSON 物件 → 失败、通用句、retry（不是明确答案）', async () => {
  for (const r0 of [new Response('<html>', { status: 200 }), res(200, 'linked'), res(200, null)]) {
    const { r } = await quiet(() => tgLink(fake(() => r0.clone()), TOKEN, 'check', { initData: INIT }));
    assert.deepEqual(r, { ok: false, status: 200, code: null, error: GENERIC, retry: true });
  }
});

test('tgLink：网络错、超时 → status 0、「需要网络」、retry', async () => {
  const want = { ok: false, status: 0, code: null, error: '需要网络', retry: true };
  assert.deepEqual((await quiet(() => tgLink(async () => { throw new TypeError('x'); }, TOKEN, 'status'))).r, want);
  assert.deepEqual((await quiet(() => tgLink(fake(hangUntilAbort), TOKEN, 'status', { timeoutMs: 30 }))).r, want);
});

test('tgLink：预设超时 bind 15 秒，其他 10 秒', async () => {
  const f = fake(() => res(200, {}));
  assert.ok((await delaysOf(() => tgLink(f, TOKEN, 'bind', { initData: INIT }))).includes(15000));
  for (const a of ['check', 'status', 'unlink']) {
    const seen = await delaysOf(() => tgLink(f, TOKEN, a, { initData: INIT }));
    assert.ok(seen.includes(10000) && !seen.includes(15000), a);
  }
});

test('tgLink：日志只有动作＋状态码，不含 token、initData', async () => {
  const { logs } = await quiet(() => tgLink(fake(() => res(500, {})), TOKEN, 'bind', { initData: INIT }));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /bind/);
  assert.match(logs[0], /500/);
  assert.ok(!logs[0].includes(TOKEN) && !logs[0].includes(INIT));
});

// ---------------- tgAdminSetup ----------------

test('tgAdminSetup：POST tg-admin {action:setup}，Bearer；{ok:true} 才算成功', async () => {
  const f = fake(() => res(200, { ok: true }));
  assert.deepEqual(await tgAdminSetup(f, TOKEN), { ok: true });
  assert.equal(f.calls[0].url, TG_ADMIN_URL);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].init.headers.apikey, SUPABASE_KEY);
  assert.deepEqual(f.calls[0].body, { action: 'setup' });
  const { r } = await quiet(() => tgAdminSetup(fake(() => res(200, {})), TOKEN));
  assert.deepEqual(r, { ok: false, error: GENERIC });
});

test('tgAdminSetup：失败句子照白名单；网络错 → 需要网络', async () => {
  const cases = [
    [res(403, { error: '没有权限' }), '没有权限'],
    [res(401, { error: '请重新登录后再试' }), '请重新登录后再试'],
    [res(502, { error: 'Telegram 暂时连不上，请稍后再试' }), 'Telegram 暂时连不上，请稍后再试'],
    [res(500, { error: '暂时无法完成，请稍后再试' }), GENERIC],
    [res(500, { error: 'boom <script>' }), GENERIC],
  ];
  for (const [r0, error] of cases) {
    const { r } = await quiet(() => tgAdminSetup(fake(() => r0.clone()), TOKEN));
    assert.deepEqual(r, { ok: false, error });
  }
  const { r } = await quiet(() => tgAdminSetup(async () => { throw new TypeError('x'); }, TOKEN));
  assert.deepEqual(r, { ok: false, error: '需要网络' });
  const seen = await delaysOf(() => tgAdminSetup(fake(() => res(200, { ok: true })), TOKEN));
  assert.ok(seen.includes(20000));
});

// ---------------- 3d：tgAdminStatus、tgAdminPause ----------------
test('tgAdminStatus：POST {action:status}；只取认得的栏位', async () => {
  const f = fake(() => res(200, { ok: true, webhook: 'ok', pending: 2, lastErrorAt: null, aiUsed24h: 5, extra: '<x>' }));
  assert.deepEqual(await tgAdminStatus(f, TOKEN), { ok: true, data: { webhook: 'ok', pending: 2, lastErrorAt: null, aiUsed24h: 5 } });
  assert.deepEqual(f.calls[0].body, { action: 'status' });
  assert.equal(f.calls[0].url, TG_ADMIN_URL);
});
test('tgAdminStatus：webhook 值不认得、栏位型别不对 → 当失败；网络错 → 需要网络', async () => {
  for (const body of [{ ok: true, webhook: 'weird', pending: 0, lastErrorAt: null, aiUsed24h: 0 },
    { ok: true, webhook: 'ok', pending: '2', lastErrorAt: null, aiUsed24h: 0 }, { ok: false }]) {
    const { r } = await quiet(() => tgAdminStatus(fake(() => res(200, body)), TOKEN));
    assert.deepEqual(r, { ok: false, error: GENERIC }, JSON.stringify(body));
  }
  const { r } = await quiet(() => tgAdminStatus(async () => { throw new TypeError('x'); }, TOKEN));
  assert.deepEqual(r, { ok: false, error: '需要网络' });
});
test('tgAdminPause：POST {action:pause}；{ok:true} 才算成功', async () => {
  const f = fake(() => res(200, { ok: true }));
  assert.deepEqual(await tgAdminPause(f, TOKEN), { ok: true });
  assert.deepEqual(f.calls[0].body, { action: 'pause' });
  const { r } = await quiet(() => tgAdminPause(fake(() => res(403, { error: '没有权限' })), TOKEN));
  assert.deepEqual(r, { ok: false, error: '没有权限' });
});
