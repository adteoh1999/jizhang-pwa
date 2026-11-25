import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBoth, fakeFetch, jsonRes, hang, envOf } from './helpers/edge-fn.js';

const ORIGIN = 'https://jizhang.adteoh.com';
const BASE = 'https://p.supabase.co';
const KEY = 'sb_secret_test';
const ENV = envOf({ SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: `{"default":"${KEY}"}` });
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'eyJ.owner-access-token.sig';
const OWNER_EMAIL = 'owner@example.invalid';
const OTHER_EMAIL = 'friend@example.invalid';
const CODE = 'K7MPQ4XZ';

const USES = [
  { id: 5, user_id: OTHER_ID, email: OTHER_EMAIL, used_at: '2026-11-25T01:00:00Z', deleted: false, owner: false, pending: false },
  { id: 4, user_id: OWNER_ID, email: OWNER_EMAIL, used_at: '2026-11-24T01:00:00Z', deleted: false, owner: true, pending: false },
  { id: 3, user_id: null, email: '', used_at: '2026-11-23T01:00:00Z', deleted: true, owner: false, pending: false },
  { id: 2, user_id: null, email: 'pend@example.invalid', used_at: '2026-11-22T01:00:00Z', deleted: false, owner: false, pending: true },
  { id: 1, user_id: OWNER_ID, email: 'me-old@example.invalid', used_at: '2026-11-21T01:00:00Z', deleted: false, owner: false, pending: false },
  // 2f 以前被删的人：纪录上的邮箱还在，但已对不到账号
  { id: 6, user_id: null, email: 'old-deleted@example.invalid', used_at: '2026-11-20T01:00:00Z', deleted: true, owner: false, pending: false },
  // 资料不一致：不是已删除也不是注册未完成，却没有 user_id
  { id: 7, user_id: null, email: 'odd@example.invalid', used_at: '2026-11-19T01:00:00Z', deleted: false, owner: false, pending: false },
];

// 记下每次 AbortSignal.timeout 的毫秒数（锁住各步骤的超时）
async function withTimeouts(fn) {
  const orig = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return orig.call(AbortSignal, ms); };
  try { await fn(); } finally { AbortSignal.timeout = orig; }
  return seen;
}

// rpc 与 admin 呼叫只能用 secret key，不能带用户的 token
function assertServerCalls(f) {
  for (const c of f.calls) {
    if (c.url.includes('/auth/v1/user')) continue;
    assert.equal(c.init.headers.apikey, KEY, c.url);
    assert.equal(c.init.headers.Authorization, undefined, c.url);
    assert.ok(!JSON.stringify(c.init.headers).includes(TOKEN), c.url);
  }
}

const req = (body, { origin = ORIGIN, method = 'POST', token = TOKEN } = {}) => new Request(`${BASE}/functions/v1/invites`, {
  method,
  headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
});

function routes({
  user = () => jsonRes(200, { id: OWNER_ID, email: 'Owner@Example.invalid', app_metadata: { kind: 'email' } }),
  isOwner = true,
  list = [{ code: CODE, status: 'active' }],
  newCode = CODE,
  setActive = true,
  uses = USES,
  delData = () => jsonRes(204),
  admin = () => jsonRes(200, {}),
} = {}) {
  return fakeFetch([
    ['/auth/v1/admin/users/', admin],
    ['/auth/v1/user', user],
    ['/rpc/svc_is_owner', () => (typeof isOwner === 'function' ? isOwner() : jsonRes(200, isOwner))],
    ['/rpc/svc_invites_list', () => jsonRes(200, list)],
    ['/rpc/svc_new_invite_code', () => jsonRes(200, newCode)],
    ['/rpc/svc_invite_set_active', () => jsonRes(200, setActive)],
    ['/rpc/svc_invite_uses', () => jsonRes(200, uses)],
    ['/rpc/svc_delete_user_data', delData],
  ]);
}

for (const [label, mod] of await loadBoth('invites')) {
  const run = (r, f, extra = {}) => mod.handleInvites(r, { env: ENV, fetch: f, ...extra });
  const call = async (body, opts = {}, extra = {}) => {
    const f = opts.f ?? routes(opts.routes);
    const res = await run(req(body, opts.req), f, extra);
    return { res, f, status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  // ---------- 一般 ----------
  test(`${label}：OPTIONS → 204 带 CORS；来源不在名单没有 allow-origin；GET → 405`, async () => {
    const ok = await run(req(null, { method: 'OPTIONS' }), routes());
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const evil = await run(req(null, { method: 'OPTIONS', origin: 'https://evil.example' }), routes());
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await run(req(null, { method: 'GET' }), routes())).status, 405);
  });

  test(`${label}：没有 token → 401，没叫任何服务`, async () => {
    const r = await call({ action: 'list' }, { req: { token: null } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: '请重新登录后再试' });
    assert.equal(r.f.calls.length, 0);
  });

  test(`${label}：token 无效（401）或账号已不存在（403 user_not_found）→ 401`, async () => {
    for (const user of [() => jsonRes(401, {}), () => jsonRes(403, { error_code: 'user_not_found' })]) {
      const r = await call({ action: 'list' }, { routes: { user } });
      assert.equal(r.status, 401);
      assert.equal(r.f.callsTo('/rpc/').length, 0);
    }
  });

  test(`${label}：查身份失败（500）→ 500`, async () => {
    const r = await call({ action: 'list' }, { routes: { user: () => jsonRes(500, {}) } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: '暂时无法完成，请稍后再试' });
  });

  test(`${label}：body 不是 JSON → 400；未知 action → 400`, async () => {
    assert.equal((await call('not json')).status, 400);
    assert.equal((await call({ action: 'drop_all' })).status, 400);
    assert.equal((await call({})).status, 400);
  });

  test(`${label}：站主判断的 rpc 失败 → 500`, async () => {
    const r = await call({ action: 'list' }, { routes: { isOwner: () => jsonRes(500, {}) } });
    assert.equal(r.status, 500);
  });

  // ---------- 身份 ----------
  test(`${label}：check：站主 → 200 {owner:true}，用小写邮箱问 svc_is_owner`, async () => {
    const r = await call({ action: 'check' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { owner: true });
    assert.deepEqual(r.f.callsTo('/rpc/svc_is_owner')[0].body, { p_email: OWNER_EMAIL });
  });

  test(`${label}：check：不是站主 → 200 {owner:false}（不回 403，console 才不会每天一条错误）`, async () => {
    const r = await call({ action: 'check' }, { routes: { isOwner: false } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { owner: false });
  });

  test(`${label}：不是站主叫 create、set_active、uses、remove_user → 都 403，没叫任何后续服务`, async () => {
    const bodies = [
      { action: 'create', max_uses: 1, days: 7 }, { action: 'set_active', code: CODE, active: false },
      { action: 'uses', code: CODE }, { action: 'remove_user', code: CODE, use_id: 5 },
    ];
    for (const b of bodies) {
      const r = await call(b, { routes: { isOwner: false } });
      assert.equal(r.status, 403, b.action);
      const later = r.f.calls.filter((c) => !c.url.includes('/auth/v1/user') && !c.url.includes('/rpc/svc_is_owner'));
      assert.deepEqual(later, [], b.action);
    }
  });

  test(`${label}：不是站主叫 list → 403，没叫 svc_invites_list`, async () => {
    const r = await call({ action: 'list' }, { routes: { isOwner: false } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: '没有权限' });
    assert.equal(r.f.callsTo('/rpc/svc_invites_list').length, 0);
  });

  test(`${label}：kind 是 telegram 的站主邮箱也不算站主（list 403、check owner:false）`, async () => {
    const user = () => jsonRes(200, { id: OWNER_ID, email: OWNER_EMAIL, app_metadata: { kind: 'telegram' } });
    assert.equal((await call({ action: 'list' }, { routes: { user } })).status, 403);
    assert.deepEqual((await call({ action: 'check' }, { routes: { user } })).body, { owner: false });
  });

  // ---------- list ----------
  test(`${label}：list → 200 {invites}`, async () => {
    const r = await call({ action: 'list' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { invites: [{ code: CODE, status: 'active' }] });
  });

  test(`${label}：list 的 rpc 回的不是阵列 → 500`, async () => {
    assert.equal((await call({ action: 'list' }, { routes: { list: { x: 1 } } })).status, 500);
  });

  // ---------- create ----------
  test(`${label}：create {max_uses:1, days:7, note:''} → rpc 参数正确，回 {code}`, async () => {
    const r = await call({ action: 'create', max_uses: 1, days: 7, note: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { code: CODE });
    assert.deepEqual(r.f.callsTo('/rpc/svc_new_invite_code')[0].body, { p_max_uses: 1, p_days: 7, p_note: '' });
  });

  test(`${label}：create 备注去掉前后空白再存、再算长度`, async () => {
    const r = await call({ action: 'create', max_uses: 1, days: 7, note: '  给小明  ' });
    assert.equal(r.f.callsTo('/rpc/svc_new_invite_code')[0].body.p_note, '给小明');
    const r2 = await call({ action: 'create', max_uses: 1, days: 7, note: ` ${'备'.repeat(40)} ` });
    assert.equal(r2.status, 200);
  });

  test(`${label}：create days null → p_days null（永不过期）；没给 note → ''；备注 40 字可以`, async () => {
    const note = '备'.repeat(40);
    const r = await call({ action: 'create', max_uses: 20, days: null, note });
    assert.equal(r.status, 200);
    assert.deepEqual(r.f.callsTo('/rpc/svc_new_invite_code')[0].body, { p_max_uses: 20, p_days: null, p_note: note });
    const r2 = await call({ action: 'create', max_uses: 2, days: 30 });
    assert.deepEqual(r2.f.callsTo('/rpc/svc_new_invite_code')[0].body, { p_max_uses: 2, p_days: 30, p_note: '' });
  });

  test(`${label}：create 设定不对 → 400，没叫 rpc`, async () => {
    const bad = [
      { max_uses: 21, days: 7 }, { max_uses: 0, days: 7 }, { max_uses: 1.5, days: 7 }, { max_uses: '1', days: 7 },
      { days: 7 }, { max_uses: 1, days: 14 }, { max_uses: 1, days: '7' }, { max_uses: 1 },
      { max_uses: 1, days: 7, note: '备'.repeat(41) }, { max_uses: 1, days: 7, note: 5 },
    ];
    for (const b of bad) {
      const r = await call({ action: 'create', ...b });
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.deepEqual(r.body, { error: '设定不正确' });
      assert.equal(r.f.callsTo('/rpc/svc_new_invite_code').length, 0);
    }
  });

  test(`${label}：create 的 rpc 回的不像码 → 500`, async () => {
    assert.equal((await call({ action: 'create', max_uses: 1, days: 7 }, { routes: { newCode: null } })).status, 500);
  });

  // ---------- set_active ----------
  test(`${label}：set_active 接受 k7mp-q4xz 并传 K7MPQ4XZ`, async () => {
    const r = await call({ action: 'set_active', code: 'k7mp-q4xz', active: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(r.f.callsTo('/rpc/svc_invite_set_active')[0].body, { p_code: CODE, p_active: false });
  });

  test(`${label}：set_active 找不到码 → 404；码格式不对 → 404；active 不是布林 → 400`, async () => {
    const r = await call({ action: 'set_active', code: CODE, active: true }, { routes: { setActive: false } });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: '找不到这个邀请码' });
    assert.equal((await call({ action: 'set_active', code: 'abc', active: true })).status, 404);
    const r3 = await call({ action: 'set_active', code: CODE, active: 'yes' });
    assert.equal(r3.status, 400);
    assert.equal(r3.f.callsTo('/rpc/svc_invite_set_active').length, 0);
  });

  // ---------- uses ----------
  test(`${label}：uses → 200，每列只回 id、email、used_at、deleted、owner、pending（不带 user_id）`, async () => {
    const r = await call({ action: 'uses', code: 'K7MP-Q4XZ' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.f.callsTo('/rpc/svc_invite_uses')[0].body, { p_code: CODE });
    assert.equal(r.body.uses.length, USES.length);
    for (const [i, u] of r.body.uses.entries()) {
      assert.deepEqual(Object.keys(u).sort(), ['deleted', 'email', 'id', 'owner', 'pending', 'used_at']);
      assert.equal(u.id, USES[i].id);
    }
    assert.ok(!JSON.stringify(r.body).includes(OTHER_ID));
  });

  test(`${label}：uses 已删除的列一律不送邮箱（2f 以前删的人纪录上还有邮箱）`, async () => {
    const r = await call({ action: 'uses', code: CODE });
    const old = r.body.uses.find((u) => u.id === 6);
    assert.equal(old.email, '');
    assert.equal(old.deleted, true);
    assert.ok(!JSON.stringify(r.body).includes('old-deleted@example.invalid'));
    assert.equal(r.body.uses.find((u) => u.id === 5).email, OTHER_EMAIL);
  });

  test(`${label}：uses 码格式不对 → 404`, async () => {
    assert.equal((await call({ action: 'uses', code: 'xx' })).status, 404);
  });

  // ---------- remove_user ----------
  test(`${label}：remove_user 成功：依序 svc_invite_uses → svc_delete_user_data(对方) → DELETE admin/users/对方`, async () => {
    const r = await call({ action: 'remove_user', code: CODE, use_id: 5 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    const order = r.f.calls.map((c) => c.url.replace(BASE, ''));
    assert.deepEqual(order.slice(-3), ['/rest/v1/rpc/svc_invite_uses', '/rest/v1/rpc/svc_delete_user_data', `/auth/v1/admin/users/${OTHER_ID}`]);
    assert.deepEqual(r.f.callsTo('/rpc/svc_delete_user_data')[0].body, { p_user_id: OTHER_ID });
    assertServerCalls(r.f);
  });

  test(`${label}：remove_user 用请求里的码（正规化后）查明细`, async () => {
    const r = await call({ action: 'remove_user', code: 'k7mp-q4xz', use_id: 5 });
    assert.deepEqual(r.f.callsTo('/rpc/svc_invite_uses')[0].body, { p_code: CODE });
  });

  test(`${label}：remove_user 各步超时：身份 3 秒、rpc 3 秒、删资料 5 秒、删账号 5 秒`, async () => {
    let status;
    const seen = await withTimeouts(async () => { status = (await call({ action: 'remove_user', code: CODE, use_id: 5 })).status; });
    assert.equal(status, 200);
    assert.deepEqual(seen, [3000, 3000, 3000, 5000, 5000]);
  });

  test(`${label}：其他动作的 rpc 都用 3 秒，且只带 secret key`, async () => {
    for (const b of [{ action: 'list' }, { action: 'create', max_uses: 1, days: 7 }, { action: 'set_active', code: CODE, active: true }, { action: 'uses', code: CODE }]) {
      let r;
      const seen = await withTimeouts(async () => { r = await call(b); });
      assert.equal(r.status, 200, b.action);
      assert.deepEqual(seen, [3000, 3000, 3000], b.action);
      assertServerCalls(r.f);
    }
  });

  test(`${label}：remove_user 站主列 → 403；自己（快照邮箱不是站主）→ 403；都没删`, async () => {
    for (const use_id of [4, 1]) {
      const r = await call({ action: 'remove_user', code: CODE, use_id });
      assert.equal(r.status, 403, `use_id ${use_id}`);
      assert.deepEqual(r.body, { error: '不能移除站主' });
      assert.equal(r.f.callsTo('/rpc/svc_delete_user_data').length, 0);
      assert.equal(r.f.callsTo('/admin/').length, 0);
    }
  });

  test(`${label}：remove_user 已删除列、注册未完成列、找不到的 id → 404`, async () => {
    for (const use_id of [3, 2, 99, 6, 7]) {
      const r = await call({ action: 'remove_user', code: CODE, use_id });
      assert.equal(r.status, 404, `use_id ${use_id}`);
      assert.deepEqual(r.body, { error: '找不到这个用户' });
      assert.equal(r.f.callsTo('/rpc/svc_delete_user_data').length, 0);
    }
  });

  test(`${label}：remove_user 的 use_id 不是安全正整数 → 400；码格式不对 → 404`, async () => {
    for (const use_id of ['5', 1.5, 0, -1, 2 ** 53, null]) {
      const r = await call({ action: 'remove_user', code: CODE, use_id });
      assert.equal(r.status, 400, String(use_id));
      assert.equal(r.f.callsTo('/rpc/svc_invite_uses').length, 0);
    }
    assert.equal((await call({ action: 'remove_user', code: 'nope', use_id: 5 })).status, 404);
  });

  test(`${label}：remove_user 删资料失败 → 500 且没删账号；删账号失败或超时 → 500`, async () => {
    const r = await call({ action: 'remove_user', code: CODE, use_id: 5 }, { routes: { delData: () => jsonRes(500, {}) } });
    assert.equal(r.status, 500);
    assert.equal(r.f.callsTo('/admin/').length, 0);
    assert.equal((await call({ action: 'remove_user', code: CODE, use_id: 5 }, { routes: { admin: () => jsonRes(500, {}) } })).status, 500);
    assert.equal((await call({ action: 'remove_user', code: CODE, use_id: 5 }, { routes: { admin: hang } }, { adminTimeoutMs: 30 })).status, 500);
  });

  test(`${label}：日志不含邮箱、邀请码、token、key`, async () => {
    const logs = [];
    const orig = console.error;
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try {
      await call({ action: 'list' }, { routes: { user: () => jsonRes(500, { msg: OWNER_EMAIL }) } });
      await call({ action: 'list' }, { routes: { isOwner: () => jsonRes(500, { message: OWNER_EMAIL }) } });
      await call({ action: 'remove_user', code: CODE, use_id: 5 }, { routes: { delData: () => jsonRes(500, { message: CODE }) } });
      await call({ action: 'remove_user', code: CODE, use_id: 5 }, { routes: { admin: () => jsonRes(500, { msg: OTHER_EMAIL }) } });
      await call({ action: 'create', max_uses: 1, days: 7 }, { routes: { newCode: null } });
    } finally { console.error = orig; }
    assert.ok(logs.length >= 5, `每种失败都要留一行日志（${logs.length}）`);
    for (const l of logs) {
      for (const s of [OWNER_EMAIL, OTHER_EMAIL, CODE, TOKEN, KEY, OTHER_ID, OWNER_ID]) assert.ok(!l.includes(s), `日志含敏感资料：${l}`);
    }
  });
}
