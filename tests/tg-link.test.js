// 3b-4：tg-link（要用户 token：bind／check／status／unlink；连接成功寄通知信）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, hang, envOf } from './helpers/edge-fn.js';
import { signInitData } from './helpers/tg-init-data.js';
import { tgLabel } from '../supabase/functions/_shared/telegram.ts';

// 全是假的测试资料
const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const BOT = '123456:' + 'C'.repeat(35);
const RESEND_KEY = 're_test_resend_key';
const FROM = '记账 <noreply@mail.example.invalid>';
const ENV_OBJ = {
  SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}`, TELEGRAM_BOT_TOKEN: BOT,
  RESEND_API_KEY: RESEND_KEY, EMAIL_FROM: FROM,
};
const ENV = envOf(ENV_OBJ);
const NOW = 1764000100;
const TID = 987654321;
const TG_USER = { id: TID, first_name: 'Zed', last_name: 'Quokka', username: 'zedquokka' };
const LABEL = tgLabel(TG_USER);
const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'tgme@example.invalid';
const TOKEN = 'eyJ.user-access-token.sig';

const initDataAt = (authDate, user = TG_USER) => signInitData({
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: JSON.stringify(user), auth_date: String(authDate),
}, BOT);
const FRESH = initDataAt(NOW - 100);

const req = (body, { origin = ORIGIN, method = 'POST', token = TOKEN } = {}) => new Request(`${BASE}/functions/v1/tg-link`, {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

function routes({
  user = () => jsonRes(200, { id: UID, email: 'TgMe@Example.invalid', app_metadata: { kind: 'email' } }),
  bind = () => jsonRes(200, 'linked'),
  linkGet = () => jsonRes(200, UID),
  status = () => jsonRes(200, { linked: true, label: LABEL, linked_at: '2026-11-26T00:00:00Z' }),
  unlink = () => jsonRes(200, true),
  logout = () => new Response(null, { status: 204 }),
  reserve = () => jsonRes(200, { do: 'send', id: 42 }),
  release = () => jsonRes(204),
  resend = () => jsonRes(200, { id: 'e1' }),
} = {}) {
  return fakeFetch([
    ['/auth/v1/user', user],
    ['/auth/v1/logout', logout],
    ['/rpc/svc_tg_bind', bind],
    ['/rpc/svc_tg_link_get', linkGet],
    ['/rpc/svc_tg_status', status],
    ['/rpc/svc_tg_unlink', unlink],
    ['/rpc/svc_tg_notify_reserve', reserve],
    ['/rpc/svc_tg_notify_release', release],
    ['api.resend.com', resend],
  ]);
}

async function quiet(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  try { return { r: await fn(), logs }; } finally { Object.assign(console, orig); }
}

// 记下每次 AbortSignal.timeout 的毫秒数（每个 fetch 前刚好建一个，所以和 f.calls 一一对应）
async function withTimeouts(fn) {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

const SECRETS = [FRESH, String(TID), TOKEN, EMAIL, 'tgme@', 'zedquokka', 'Quokka', KEY, BOT, RESEND_KEY, UID];
function assertCleanLogs(logs, what) {
  const all = logs.join('\n');
  for (const s of SECRETS) assert.ok(!all.includes(s), `${what}：日志不能含 ${s.slice(0, 12)}…`);
}

// rpc 只能用 secret key，不能带用户的 token
function assertServerCalls(f) {
  for (const c of f.calls.filter((c) => c.url.includes('/rest/v1/'))) {
    assert.equal(c.init.headers.apikey, KEY, c.url);
    assert.ok(!JSON.stringify(c.init.headers).includes(TOKEN), c.url);
  }
}

const mailOf = (f) => f.callsTo('api.resend.com').map((c) => c.body);

for (const [label, mod] of await loadBoth('tg-link')) {
  const run = async (body, f, { env = ENV, now = NOW, ...opts } = {}) => {
    const { r: res, logs } = await quiet(() => mod.handleTgLink(req(body, opts), { env, fetch: f, nowSec: () => now }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 没有内容 */ }
    return { res, status: res.status, body: json, text, logs };
  };

  // ---------- 共通 ----------

  test(`${label}：OPTIONS → 204＋CORS；GET → 405`, async () => {
    const o = await run(null, routes(), { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal((await run(null, routes(), { method: 'GET' })).status, 405);
  });

  test(`${label}：没有 Bearer → 401，没叫任何服务器`, async () => {
    const f = routes();
    const r = await run({ action: 'status' }, f, { token: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: '请重新登录后再试' });
    assert.equal(f.calls.length, 0);
  });

  test(`${label}：body 坏掉、action 不认识 → 400，没叫任何服务器`, async () => {
    for (const b of ['not json', {}, { action: 'nuke' }, { action: 1 }, ['bind']]) {
      const f = routes();
      const r = await run(b, f);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.deepEqual(r.body, { error: '看不懂这个请求' });
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：bind／check 没带 initData 字串 → 400，没叫 rpc`, async () => {
    for (const action of ['bind', 'check']) {
      for (const initData of [undefined, 5, null]) {
        const f = routes();
        const r = await run({ action, initData }, f);
        assert.equal(r.status, 400, `${action} ${initData}`);
        assert.equal(f.callsTo('/rest/v1/').length, 0);
      }
    }
  });

  test(`${label}：缺 SUPABASE_URL／secret key → 500，没叫任何服务器`, async () => {
    for (const env of [envOf({ ...ENV_OBJ, SUPABASE_URL: undefined }), envOf({ ...ENV_OBJ, SUPABASE_SECRET_KEYS: undefined })]) {
      const f = routes();
      const r = await run({ action: 'status' }, f, { env });
      assert.equal(r.status, 500);
      assert.equal(f.calls.length, 0);
    }
  });

  test(`${label}：bind／check 的 bot token 缺、空白、太短 → 500，没叫任何服务器；status／unlink 不需要 bot token`, async () => {
    for (const t of [undefined, '', '  ', '1:x']) {
      const env = envOf({ ...ENV_OBJ, TELEGRAM_BOT_TOKEN: t });
      for (const action of ['bind', 'check']) {
        const f = routes();
        const r = await run({ action, initData: FRESH }, f, { env });
        assert.equal(r.status, 500, `${action} ${t}`);
        assert.equal(f.calls.length, 0);
      }
      assert.equal((await run({ action: 'status' }, routes(), { env })).status, 200);
      assert.equal((await run({ action: 'unlink' }, routes(), { env })).status, 200);
    }
  });

  test(`${label}：token 无效、账号已不在 → 401；查身份失败 → 500；不是邮箱账号 → 403；都没叫 rpc`, async () => {
    const cases = [
      [() => jsonRes(401, {}), 401, { error: '请重新登录后再试' }],
      [() => jsonRes(403, { error_code: 'user_not_found' }), 401, { error: '请重新登录后再试' }],
      [() => jsonRes(500, {}), 500, null],
      [() => jsonRes(200, { id: UID, email: EMAIL, app_metadata: { kind: 'anon' } }), 403, { error: '没有权限' }],
    ];
    for (const action of ['bind', 'check', 'status', 'unlink']) {
      for (const [user, want, body] of cases) {
        const f = routes({ user });
        const r = await run({ action, initData: FRESH }, f);
        assert.equal(r.status, want, `${action} → ${want}`);
        if (body) assert.deepEqual(r.body, body);
        assert.equal(f.callsTo('/rest/v1/').length, 0);
      }
    }
  });

  test(`${label}：查身份带用户 token；rpc 只用 secret key`, async () => {
    const f = routes();
    await run({ action: 'bind', initData: FRESH }, f);
    const u = f.callsTo('/auth/v1/user')[0];
    assert.equal(u.init.headers.Authorization, `Bearer ${TOKEN}`);
    assertServerCalls(f);
  });

  test(`${label}：每种回应都 no-store`, async () => {
    const outs = [
      await run({ action: 'bind', initData: FRESH }, routes()),
      await run({ action: 'check', initData: FRESH }, routes()),
      await run({ action: 'status' }, routes()),
      await run({ action: 'unlink' }, routes()),
      await run({ action: 'status' }, routes(), { token: null }),
      await run({ action: 'nuke' }, routes()),
      await run({ action: 'bind', initData: initDataAt(NOW - 601) }, routes()),
    ];
    for (const o of outs) assert.equal(o.res.headers.get('Cache-Control'), 'no-store', String(o.status));
  });

  // ---------- bind ----------

  test(`${label}：bind 结果码对应`, async () => {
    const cases = [
      ['linked', 200, { result: 'linked' }],
      ['already', 200, { result: 'already' }],
      ['telegram_taken', 409, { code: 'telegram_taken', error: '这个 Telegram 已连接另一个邮箱' }],
      ['user_taken', 409, { code: 'user_taken', error: '这个邮箱已连接另一个 Telegram，请先在 PWA 设置里解除连接' }],
      ['no_user', 401, { error: '请重新登录后再试' }],
      ['not_email', 403, { error: '没有权限' }],
      ['weird', 500, { error: '暂时无法连接，请稍后再试' }],
    ];
    for (const [result, want, body] of cases) {
      const r = await run({ action: 'bind', initData: FRESH }, routes({ bind: () => jsonRes(200, result) }));
      assert.equal(r.status, want, result);
      assert.deepEqual(r.body, body, result);
    }
  });

  test(`${label}：bind 送 telegram_id（数字）、user id、验签后的名字；body 里另给的 label 被忽略`, async () => {
    const f = routes();
    await run({ action: 'bind', initData: FRESH, label: '假名字' }, f);
    assert.deepEqual(f.callsTo('/rpc/svc_tg_bind')[0].body, { p_telegram_id: TID, p_user_id: UID, p_label: LABEL });
  });

  test(`${label}：bind 锁超时（55P03）→ 503 busy；其他 rpc 错误 → 500；都不寄信`, async () => {
    const busy = await run({ action: 'bind', initData: FRESH }, routes({ bind: () => jsonRes(500, { code: '55P03', message: 'lock' }) }));
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.body, { code: 'busy', error: '系统忙碌，请再试一次' });
    for (const bind of [() => jsonRes(500, { code: 'P0001' }), () => { throw new TypeError('x'); }, () => jsonRes(200, 5)]) {
      const f = routes({ bind });
      const r = await run({ action: 'bind', initData: FRESH }, f);
      assert.equal(r.status, 500);
      assert.equal(f.callsTo('/rpc/svc_tg_notify_reserve').length, 0);
      assertCleanLogs(r.logs, 'bind 错误');
    }
  });

  test(`${label}：bind 的 rpc 超时是 4000 毫秒，Resend 是 2500 毫秒`, async () => {
    const f = routes();
    const seen = await withTimeouts(() => run({ action: 'bind', initData: FRESH }, f));
    assert.equal(seen.length, f.calls.length);
    const at = (part) => seen[f.calls.findIndex((c) => c.url.includes(part))];
    assert.equal(at('/rpc/svc_tg_bind'), 4000);
    assert.equal(at('api.resend.com'), 2500);
  });

  test(`${label}：bind 的 initData 超过 600 秒 → 422 init_stale（不是 401），没叫 bind`, async () => {
    for (const age of [601, 5000, 86401]) {
      const f = routes();
      const r = await run({ action: 'bind', initData: initDataAt(NOW - age) }, f);
      assert.equal(r.status, 422, String(age));
      assert.deepEqual(r.body, { code: 'init_stale', error: '太久没有完成，请关掉再重新打开' });
      assert.equal(f.callsTo('/rpc/svc_tg_bind').length, 0);
    }
    assert.equal((await run({ action: 'bind', initData: initDataAt(NOW - 599) }, routes())).status, 200);
  });

  test(`${label}：bind 坏 hash、时间超前 → 401 无法确认 Telegram 身份，没叫 bind；日志只有原因种类`, async () => {
    for (const d of [FRESH.replace(/hash=[0-9a-f]{4}/, 'hash=0000'), initDataAt(NOW + 61)]) {
      const f = routes();
      const r = await run({ action: 'bind', initData: d }, f);
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: '无法确认 Telegram 身份' });
      assert.equal(f.callsTo('/rpc/svc_tg_bind').length, 0);
      assertCleanLogs(r.logs, '坏 initData');
    }
  });

  // ---------- 通知信 ----------

  test(`${label}：linked → 预约（telegram_id、user id）→ 寄一封纯文字信（没有 html 栏位）`, async () => {
    const f = routes();
    const r = await run({ action: 'bind', initData: FRESH }, f);
    assert.deepEqual(r.body, { result: 'linked' });
    assert.deepEqual(f.callsTo('/rpc/svc_tg_notify_reserve')[0].body, { p_telegram_id: TID, p_user_id: UID });
    const mails = mailOf(f);
    assert.equal(mails.length, 1);
    assert.deepEqual(Object.keys(mails[0]).sort(), ['from', 'subject', 'text', 'to']);
    assert.equal(mails[0].from, FROM);
    assert.deepEqual(mails[0].to, [EMAIL]);
    assert.equal(mails[0].subject, '你的记账已连接 Telegram');
    assert.equal(mails[0].text,
      `Telegram 用户「${LABEL}」刚刚连接到你的记账账号。如果不是你本人操作，请到记账 App 设置里按「解除 Telegram 连接」。`);
    const c = f.callsTo('api.resend.com')[0];
    assert.equal(c.url, 'https://api.resend.com/emails');
    assert.equal(c.init.headers.Authorization, `Bearer ${RESEND_KEY}`);
    assert.equal(f.callsTo('/rpc/svc_tg_notify_release').length, 0);
    assertCleanLogs(r.logs, '寄信');
  });

  test(`${label}：already 且还没寄过（预约回 send）→ 寄；已寄过（skip）→ 不寄`, async () => {
    const a = routes({ bind: () => jsonRes(200, 'already') });
    await run({ action: 'bind', initData: FRESH }, a);
    assert.equal(mailOf(a).length, 1);
    const b = routes({ bind: () => jsonRes(200, 'already'), reserve: () => jsonRes(200, { do: 'skip' }) });
    const r = await run({ action: 'bind', initData: FRESH }, b);
    assert.deepEqual(r.body, { result: 'already' });
    assert.equal(mailOf(b).length, 0);
  });

  test(`${label}：24 小时超过 3 封（limited）→ 不寄，日志只有固定文字`, async () => {
    const f = routes({ reserve: () => jsonRes(200, { do: 'limited' }) });
    const r = await run({ action: 'bind', initData: FRESH }, f);
    assert.deepEqual(r.body, { result: 'linked' });
    assert.equal(mailOf(f).length, 0);
    assert.match(r.logs.join('\n'), /通知信/);
    assertCleanLogs(r.logs, 'limited');
  });

  test(`${label}：Resend 失败（500、连线错、超时）→ bind 仍回 200，并撤回预约（id、telegram_id）`, async () => {
    for (const resend of [() => jsonRes(500, { message: EMAIL }), () => { throw new TypeError('net ' + EMAIL); }, hang]) {
      const f = routes({ resend });
      const r = await run({ action: 'bind', initData: FRESH }, f);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { result: 'linked' });
      assert.deepEqual(f.callsTo('/rpc/svc_tg_notify_release').map((c) => c.body), [{ p_id: 42, p_telegram_id: TID }]);
      assertCleanLogs(r.logs, 'Resend 失败');
      assert.ok(!r.logs.join('\n').includes('net '), '外来错误讯息不能进日志');
    }
  });

  test(`${label}：预约出错、撤回出错、预约回传怪东西 → bind 照样回 200`, async () => {
    const cases = [
      { reserve: () => jsonRes(500, {}) },
      { reserve: () => { throw new TypeError('x'); } },
      { reserve: () => jsonRes(200, { do: 'send' }) },  // 没有 id
      { reserve: () => jsonRes(200, null) },
      { resend: () => jsonRes(500, {}), release: () => jsonRes(500, {}) },
    ];
    for (const over of cases) {
      const f = routes(over);
      const r = await run({ action: 'bind', initData: FRESH }, f);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { result: 'linked' });
      assertCleanLogs(r.logs, '预约出错');
    }
    // 没有 id 的 send 不寄（没办法撤回）
    const f = routes({ reserve: () => jsonRes(200, { do: 'send' }) });
    await run({ action: 'bind', initData: FRESH }, f);
    assert.equal(mailOf(f).length, 0);
  });

  test(`${label}：缺 RESEND_API_KEY 或 EMAIL_FROM → 不叫 Resend、撤回预约，bind 照样回 200`, async () => {
    for (const k of ['RESEND_API_KEY', 'EMAIL_FROM']) {
      const f = routes();
      const r = await run({ action: 'bind', initData: FRESH }, f, { env: envOf({ ...ENV_OBJ, [k]: undefined }) });
      assert.deepEqual(r.body, { result: 'linked' });
      assert.equal(mailOf(f).length, 0);
      assert.equal(f.callsTo('/rpc/svc_tg_notify_release').length, 1);
    }
  });

  test(`${label}：telegram_taken、user_taken、no_user、not_email → 不预约、不寄信`, async () => {
    for (const result of ['telegram_taken', 'user_taken', 'no_user', 'not_email']) {
      const f = routes({ bind: () => jsonRes(200, result) });
      await run({ action: 'bind', initData: FRESH }, f);
      assert.equal(f.callsTo('/rpc/svc_tg_notify_reserve').length, 0, result);
      assert.equal(mailOf(f).length, 0, result);
    }
  });

  test(`${label}：通知信的名字：像网址就换成通用句；超过 32 字截断；空名字也用通用句`, async () => {
    const GENERIC = '一个 Telegram 账号刚刚连接到你的记账账号。如果不是你本人操作，请到记账 App 设置里按「解除 Telegram 连接」。';
    const textFor = async (user) => {
      const f = routes();
      await run({ action: 'bind', initData: initDataAt(NOW - 100, user) }, f);
      return mailOf(f)[0].text;
    };
    for (const first_name of ['Visit evil.com', 'go https://x', 'www.x', 'a://b', 'Shop.NOW']) {
      assert.equal(await textFor({ id: TID, first_name }), GENERIC, first_name);
    }
    assert.equal(await textFor({ id: TID }), GENERIC, '空名字');
    const long = '甲'.repeat(40);
    assert.equal(await textFor({ id: TID, first_name: long }),
      `Telegram 用户「${'甲'.repeat(32)}」刚刚连接到你的记账账号。如果不是你本人操作，请到记账 App 设置里按「解除 Telegram 连接」。`);
    assert.match(await textFor({ id: TID, first_name: 'Ann', last_name: 'Lee' }), /^Telegram 用户「Ann Lee」/);
  });

  // ---------- check ----------

  test(`${label}：check：连着这个账号 → linked:true；连别人或没连 → false`, async () => {
    for (const [lg, want] of [[UID, true], [OTHER, false], [null, false]]) {
      const f = routes({ linkGet: () => jsonRes(200, lg) });
      const r = await run({ action: 'check', initData: initDataAt(NOW - 86000) }, f);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { linked: want }, String(lg));
      assert.deepEqual(f.callsTo('/rpc/svc_tg_link_get')[0].body, { p_telegram_id: TID });
    }
  });

  test(`${label}：check：超过 86400 秒 → 422 init_stale；坏 hash → 401；rpc 失败 → 500`, async () => {
    const old = await run({ action: 'check', initData: initDataAt(NOW - 86401) }, routes());
    assert.equal(old.status, 422);
    assert.equal(old.body.code, 'init_stale');
    const bad = await run({ action: 'check', initData: FRESH.replace(/hash=[0-9a-f]{4}/, 'hash=0000') }, routes());
    assert.equal(bad.status, 401);
    const err = await run({ action: 'check', initData: FRESH }, routes({ linkGet: () => jsonRes(500, {}) }));
    assert.equal(err.status, 500);
  });

  // ---------- status ----------

  test(`${label}：status → {linked, label}；没连接 label 是空字串；rpc 失败 → 500`, async () => {
    const f = routes();
    const a = await run({ action: 'status' }, f);
    assert.deepEqual(a.body, { linked: true, label: LABEL });
    assert.deepEqual(f.callsTo('/rpc/svc_tg_status')[0].body, { p_user_id: UID });
    const b = await run({ action: 'status' }, routes({ status: () => jsonRes(200, { linked: false }) }));
    assert.deepEqual(b.body, { linked: false, label: '' });
    const c = await run({ action: 'status' }, routes({ status: () => jsonRes(200, { linked: true, label: null }) }));
    assert.deepEqual(c.body, { linked: true, label: '' });
    assert.equal((await run({ action: 'status' }, routes({ status: () => jsonRes(500, {}) }))).status, 500);
    assert.equal((await run({ action: 'status' }, routes({ status: () => jsonRes(200, 'x') }))).status, 500);
  });

  // ---------- unlink ----------

  test(`${label}：unlink：先解除再登出其他设备（scope=others、用户 token）`, async () => {
    const f = routes();
    const r = await run({ action: 'unlink' }, f);
    assert.deepEqual(r.body, { ok: true, unlinked: true, others: true });
    assert.deepEqual(f.callsTo('/rpc/svc_tg_unlink')[0].body, { p_user_id: UID });
    const iU = f.calls.findIndex((c) => c.url.includes('/rpc/svc_tg_unlink'));
    const iL = f.calls.findIndex((c) => c.url.includes('/auth/v1/logout'));
    assert.ok(iU >= 0 && iL > iU, '先 unlink 后 logout');
    assert.equal(f.calls[iL].url, `${BASE}/auth/v1/logout?scope=others`);
    assert.equal(f.calls[iL].init.headers.Authorization, `Bearer ${TOKEN}`);
  });

  test(`${label}：unlink：原本就没连接（false）也会登出其他设备；登出失败 → others:false`, async () => {
    const a = routes({ unlink: () => jsonRes(200, false) });
    const ra = await run({ action: 'unlink' }, a);
    assert.deepEqual(ra.body, { ok: true, unlinked: false, others: true });
    assert.equal(a.callsTo('/auth/v1/logout').length, 1);
    const rb = await run({ action: 'unlink' }, routes({ logout: () => jsonRes(500, {}) }));
    assert.deepEqual(rb.body, { ok: true, unlinked: true, others: false });
  });

  test(`${label}：unlink：svc_tg_unlink 出错或回传不是布林 → 500，不登出`, async () => {
    for (const unlink of [() => jsonRes(500, {}), () => { throw new TypeError('x'); }, () => jsonRes(200, 'yes')]) {
      const f = routes({ unlink });
      const r = await run({ action: 'unlink' }, f);
      assert.equal(r.status, 500);
      assert.equal(f.callsTo('/auth/v1/logout').length, 0);
    }
  });
}
