// 3e：关键词表的主键是 keyword（没有 id 栏）。本地用 id＝keyword 当别名，只在 rest.js 设定每张表的主键栏位。
// 账目、分类的网址必须跟改之前一字不差。
import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertRows, selectPage, UPLOAD_COLUMNS, TABLE_KEY } from '../js/rest.js';
import { SUPABASE_URL } from '../js/config.js';

function fakeFetch(body = []) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => body }; };
  return { fn, calls };
}
const B = `${SUPABASE_URL}/rest/v1`;

test('TABLE_KEY 与上传栏位', () => {
  assert.deepEqual(TABLE_KEY, { transactions: 'id', categories: 'id', category_keywords: 'keyword' });
  assert.deepEqual([...UPLOAD_COLUMNS.category_keywords], ['keyword', 'category_id', 'updated_at', 'deleted']);
});

test('账目、分类的上传与拉取网址不变', async () => {
  const f = fakeFetch();
  await upsertRows(f.fn, 'transactions', [], 'tok');
  await upsertRows(f.fn, 'categories', [], 'tok');
  await selectPage(f.fn, 'transactions', {}, 'tok');
  await selectPage(f.fn, 'categories', { since: '2026-11-27T00:00:00Z' }, 'tok');
  await selectPage(f.fn, 'transactions', { after: { ts: '2026-11-27T00:00:00.123456+00:00', id: 'a1' } }, 'tok');
  assert.deepEqual(f.calls.map((c) => c.url), [
    `${B}/transactions?on_conflict=user_id,id&columns=id,kind,amount_minor,category_id,occurred_on,note,created_at,updated_at,deleted&select=id,updated_at`,
    `${B}/categories?on_conflict=user_id,id&columns=id,kind,name,icon,sort,updated_at,deleted&select=id,updated_at`,
    `${B}/transactions?select=id,kind,amount_minor,category_id,occurred_on,note,created_at,updated_at,deleted,server_updated_at&order=server_updated_at.asc,id.asc&limit=1000`,
    `${B}/categories?select=id,kind,name,icon,sort,updated_at,deleted,server_updated_at&order=server_updated_at.asc,id.asc&limit=1000&server_updated_at=gt.2026-11-27T00%3A00%3A00Z`,
    `${B}/transactions?select=id,kind,amount_minor,category_id,occurred_on,note,created_at,updated_at,deleted,server_updated_at&order=server_updated_at.asc,id.asc&limit=1000`
      + '&or=(server_updated_at.gt.%222026-11-27T00%3A00%3A00.123456%2B00%3A00%22,and(server_updated_at.eq.%222026-11-27T00%3A00%3A00.123456%2B00%3A00%22,id.gt.%22a1%22))',
  ]);
});

test('关键词上传：on_conflict 用 keyword、回传别名 id、body 不带 id／dirty／sync_error', async () => {
  const f = fakeFetch([{ id: 'grab', updated_at: 'x' }]);
  const r = await upsertRows(f.fn, 'category_keywords',
    [{ id: 'grab', keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T00:00:00.000Z', deleted: false, dirty: 1, sync_error: { code: 'x' } }], 'tok');
  assert.equal(f.calls[0].url, `${B}/category_keywords?on_conflict=user_id,keyword&columns=keyword,category_id,updated_at,deleted&select=id:keyword,updated_at`);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), [{ keyword: 'grab', category_id: 'transport', updated_at: '2026-11-27T00:00:00.000Z', deleted: false }]);
  assert.deepEqual(r.rows, [{ id: 'grab', updated_at: 'x' }]);
});

test('关键词拉取：select 带别名 id、排序与 keyset 用 keyword；特殊字元正确编码', async () => {
  const f = fakeFetch();
  await selectPage(f.fn, 'category_keywords', {}, 'tok');
  const weird = 'a"b\\c,d(e)%+😀 猫';
  await selectPage(f.fn, 'category_keywords', { after: { ts: '2026-11-27T00:00:00+00:00', id: weird } }, 'tok');
  assert.equal(f.calls[0].url,
    `${B}/category_keywords?select=keyword,category_id,updated_at,deleted,server_updated_at,id:keyword&order=server_updated_at.asc,keyword.asc&limit=1000`);
  const u = f.calls[1].url;
  assert.ok(u.startsWith(`${B}/category_keywords?select=keyword,category_id,updated_at,deleted,server_updated_at,id:keyword&order=server_updated_at.asc,keyword.asc&limit=1000&or=(`));
  const or = decodeURIComponent(u.slice(u.indexOf('&or=') + 4));
  assert.equal(or, '(server_updated_at.gt."2026-11-27T00:00:00+00:00",and(server_updated_at.eq."2026-11-27T00:00:00+00:00",keyword.gt."a\\"b\\\\c,d(e)%+😀 猫"))');
  // 值包在编码过的双引号 %22…%22 里（PostgREST：引号里的逗号、括号当普通字）；逗号、引号、反斜线、空白、% 都要编码。
  // 括号 encodeURIComponent 不编码，在引号里是合法的（真服务器上线前另做冒烟测试确认）。
  const raw = u.slice(u.indexOf('keyword.gt.') + 'keyword.gt.'.length, -2);
  assert.ok(raw.startsWith('%22') && raw.endsWith('%22'), raw);
  assert.ok(!/[",\\ ]/.test(raw), raw);
  assert.ok(!/%(?![0-9A-F]{2})/.test(raw), '% 要编码成 %25');
});
