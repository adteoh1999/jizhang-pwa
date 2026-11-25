// 2f Task 5：js/admin-api.js（invites、delete-account 的前端客户端）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callInvites, deleteAccount } from '../js/admin-api.js';
import { SUPABASE_URL, SUPABASE_KEY } from '../js/config.js';

const TOKEN = 'eyJ.user-token.sig';
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
// 记下 setTimeout 的毫秒数（锁住默认超时）
async function delaysOf(fn) {
  const orig = globalThis.setTimeout;
  const seen = [];
  globalThis.setTimeout = (cb, ms, ...a) => { seen.push(ms); return orig(cb, ms, ...a); };
  try { await fn(); } finally { globalThis.setTimeout = orig; }
  return seen;
}

test('callInvites：POST functions/v1/invites，带 apikey、Bearer token、JSON；body 是 {action, ...args}', async () => {
  const f = fake(() => res(200, { invites: [] }));
  const r = await callInvites(f, TOKEN, 'list');
  assert.deepEqual(r, { ok: true, data: { invites: [] } });
  const c = f.calls[0];
  assert.equal(c.url, `${SUPABASE_URL}/functions/v1/invites`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.apikey, SUPABASE_KEY);
  assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { action: 'list' });
  await callInvites(f, TOKEN, 'create', { max_uses: 1, days: null, note: '' });
  assert.deepEqual(f.calls[1].body, { action: 'create', max_uses: 1, days: null, note: '' });
});

test('callInvites：args 里的 action 不能盖掉第三个参数', async () => {
  const f = fake(() => res(200, {}));
  await callInvites(f, TOKEN, 'list', { action: 'remove_user' });
  assert.equal(f.calls[0].body.action, 'list');
});

test('callInvites：网络错误或超时 → status 0、「需要网络」', async () => {
  const f = fake(() => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await callInvites(f, TOKEN, 'list'), { ok: false, status: 0, error: '需要网络' });
  const g = fake(hangUntilAbort);
  assert.deepEqual(await callInvites(g, TOKEN, 'list', {}, { timeoutMs: 20 }), { ok: false, status: 0, error: '需要网络' });
});

test('callInvites：500 没有内容 → 固定中文', async () => {
  const f = fake(() => res(500));
  assert.deepEqual(await callInvites(f, TOKEN, 'list'), { ok: false, status: 500, error: '暂时无法完成，请稍后再试' });
});

test('callInvites：401、403 传回状态码与服务器的中文句子', async () => {
  const f = fake(() => res(401, { error: '请重新登录后再试' }));
  assert.deepEqual(await callInvites(f, TOKEN, 'list'), { ok: false, status: 401, error: '请重新登录后再试' });
  const g = fake(() => res(403, { error: '不能移除站主' }));
  assert.deepEqual(await callInvites(g, TOKEN, 'remove_user', { code: 'K7MPQ4XZ', use_id: 1 }), { ok: false, status: 403, error: '不能移除站主' });
});

test('callInvites：不认识的错误句子（英文、平台错误）换成固定中文', async () => {
  for (const body of [{ error: 'Internal Server Error' }, { msg: 'Function not found' }, { error: 42 }]) {
    const f = fake(() => res(502, body));
    assert.equal((await callInvites(f, TOKEN, 'list')).error, '暂时无法完成，请稍后再试');
  }
});

test('callInvites：默认超时 10 秒；remove_user 30 秒（服务器最坏约 19 秒）', async () => {
  const f = fake(() => res(200, {}));
  assert.ok((await delaysOf(() => callInvites(f, TOKEN, 'list'))).includes(10000));
  assert.ok((await delaysOf(() => callInvites(f, TOKEN, 'remove_user', { code: 'K7MPQ4XZ', use_id: 1 }))).includes(30000));
});

test('deleteAccount：POST functions/v1/delete-account，带 token；200 → ok', async () => {
  const f = fake(() => res(200, { ok: true }));
  assert.deepEqual(await deleteAccount(f, TOKEN), { ok: true });
  assert.equal(f.calls[0].url, `${SUPABASE_URL}/functions/v1/delete-account`);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].init.headers.apikey, SUPABASE_KEY);
});

test('deleteAccount：失败照样回状态码与中文；网络错 status 0；默认超时 20 秒', async () => {
  const f = fake(() => res(500, { error: '暂时无法删除，请稍后再试' }));
  assert.deepEqual(await deleteAccount(f, TOKEN), { ok: false, status: 500, error: '暂时无法删除，请稍后再试' });
  const g = fake(() => { throw new TypeError('x'); });
  assert.deepEqual(await deleteAccount(g, TOKEN), { ok: false, status: 0, error: '需要网络' });
  const h = fake(() => res(200, { ok: true }));
  assert.ok((await delaysOf(() => deleteAccount(h, TOKEN))).includes(20000));
});

test('2xx 但内容不是 JSON：invites 当失败（要有资料）；delete-account 仍算成功', async () => {
  const f = fake(() => new Response('oops', { status: 200 }));
  assert.equal((await callInvites(f, TOKEN, 'list')).ok, false);
  assert.deepEqual(await deleteAccount(f, TOKEN), { ok: true });
});
