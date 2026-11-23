import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleWhoami } from '../supabase/functions/whoami/index.ts';

test('whoami：只回传和 IP 有关的 header 值，其他只回名字；绝不回传 authorization、apikey 的值', async () => {
  const req = new Request('https://p/functions/v1/whoami', { headers: {
    'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '5.6.7.8',
    authorization: 'Bearer SECRET_A', apikey: 'SECRET_B', cookie: 'SECRET_C',
  } });
  const res = handleWhoami(req);
  const text = await res.clone().text();
  assert.doesNotMatch(text, /SECRET_/);
  const out = await res.json();
  assert.equal(out.ip_headers['x-forwarded-for'], '1.2.3.4, 5.6.7.8');
  assert.equal(out.ip_headers['x-real-ip'], '5.6.7.8');
  assert.ok(out.all_header_names.includes('authorization'));
});
