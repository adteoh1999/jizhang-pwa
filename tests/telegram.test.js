import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tgBotTokenOk, tgLabel, tgVerifyInitData } from '../supabase/functions/_shared/telegram.ts';
import { SHARED_IMPORT_FORBIDDEN } from '../scripts/build-functions.mjs';
import { signInitData } from './helpers/tg-init-data.js';

// 全是假的测试资料
const TOKEN = '123456:' + 'A'.repeat(35);
const NOW = 1764000100;
const AGE = 600;
const USER = { id: 987654321, first_name: 'Alice', last_name: 'Tan', username: 'alice', language_code: 'zh' };
const base = (over = {}) => ({
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  user: JSON.stringify(USER),
  auth_date: '1764000000',
  signature: 'c2lnbmF0dXJlLXRlc3Q',
  ...over,
});
const good = () => signInitData(base(), TOKEN);
const verify = (s, token = TOKEN, now = NOW, age = AGE) => tgVerifyInitData(s, token, now, age);
const edit = (s, fn) => { const p = new URLSearchParams(s); fn(p); return p.toString(); };
const OK = { telegramId: '987654321', label: '@alice' };

// ---------- 固定答案（不靠测试用签名工具） ----------
// hash 由主会话用 openssl 独立算出（2026-11-26）：
//   SECRET=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -mac HMAC -macopt key:WebAppData -hex)
//   printf '%s' "$DCS" | openssl dgst -sha256 -mac HMAC -macopt hexkey:$SECRET -hex
// DCS = 'auth_date=1764000000\nquery_id=AAHdF6IQAAAAAN0XohDhrOrc\nsignature=c2lnbmF0dXJlLXRlc3Q\nuser={…}'
test('initData：固定答案（openssl 独立算的 hash，含 signature）→ 通过', async () => {
  const userJson = '{"id":987654321,"first_name":"Alice","last_name":"Tan","username":"alice","language_code":"zh"}';
  const s = 'user=' + encodeURIComponent(userJson)
    + '&signature=c2lnbmF0dXJlLXRlc3Q&query_id=AAHdF6IQAAAAAN0XohDhrOrc&auth_date=1764000000'
    + '&hash=7049826c57bcd881eeecec7439550afba4c4aa4862993f70b51a3944129092fd';
  assert.deepEqual(await verify(s), OK);
});

// ---------- bot token 格式 ----------
test('tgBotTokenOk：合格 → true；前后有空白、换行也算合格', () => {
  assert.equal(tgBotTokenOk(TOKEN), true);
  assert.equal(tgBotTokenOk('  ' + TOKEN + '\n'), true);
});

test('tgBotTokenOk：缺少、空白、格式不对 → false', () => {
  for (const t of [undefined, '', '   ', 'abc', '123:short', '1234:' + 'A'.repeat(35), '123456:' + 'A'.repeat(29), '123456:' + 'A'.repeat(34) + '!']) {
    assert.equal(tgBotTokenOk(t), false, String(t));
  }
});

test('initData：Secret 贴上时多了换行，资料用干净 token 签 → 照常通过', async () => {
  assert.deepEqual(await verify(good(), TOKEN + '\n'), OK);
  assert.deepEqual(await verify(good(), '  ' + TOKEN), OK);
});

test('initData：用另一个 token 签 → null', async () => {
  assert.deepEqual(await verify(good()), OK);
  assert.equal(await verify(signInitData(base(), '654321:' + 'B'.repeat(35))), null);
});

test('initData：botToken 是空字串（就算资料也用空字串签）→ null', async () => {
  assert.equal(await verify(signInitData(base(), ''), ''), null);
  assert.equal(await verify(good(), ''), null);
  assert.equal(await tgVerifyInitData(good(), undefined, NOW, AGE), null); // 不经过 verify()：默认参数会把 undefined 换回 TOKEN
});

// ---------- 参数防呆：设定读错不能变成永不过期 ----------
test('initData：maxAgeSec 不合格 → null', async () => {
  assert.deepEqual(await verify(good()), OK);
  for (const age of [undefined, NaN, 0, -1, Infinity, 86401, '600']) {
    assert.equal(await tgVerifyInitData(good(), TOKEN, NOW, age), null, String(age)); // 直接叫：verify() 的默认参数会吞掉 undefined
  }
});

test('initData：nowSec 不合格 → null', async () => {
  for (const now of [NaN, 0, -1, Infinity, undefined, '1764000100']) {
    assert.equal(await tgVerifyInitData(good(), TOKEN, now, AGE), null, String(now));
  }
});

test('initData：maxAgeSec = 86400（上限）→ 通过', async () => {
  assert.deepEqual(await verify(good(), TOKEN, NOW, 86400), OK);
});

// ---------- 签完以后被改过（hash 对不上） ----------
const tampered = {
  '改 auth_date': (s) => edit(s, (p) => p.set('auth_date', '1764000001')),
  '追加一个没签的栏位': (s) => s + '&extra=1',
  '删掉 signature': (s) => edit(s, (p) => p.delete('signature')),
  'user 换成另一个人、hash 不变': (s) => edit(s, (p) => p.set('user', JSON.stringify({ ...USER, id: 111 }))),
  'hash 换成另一份资料的': (s) => edit(s, (p) => p.set('hash', new URLSearchParams(signInitData(base({ query_id: 'X' }), TOKEN)).get('hash'))),
  'hash 少一个字': (s) => edit(s, (p) => p.set('hash', p.get('hash').slice(1))),
  'hash 出现两次': (s) => s + '&hash=' + new URLSearchParams(s).get('hash'),
  'auth_date 出现两次（值一样）': (s) => s + '&auth_date=1764000000',
  '缺 hash': (s) => edit(s, (p) => p.delete('hash')),
};
for (const [name, mutate] of Object.entries(tampered)) {
  test(`initData 被改过：${name} → null`, async () => {
    const s = good();
    assert.deepEqual(await verify(s), OK, '原资料要先能通过');
    assert.equal(await verify(mutate(s)), null);
  });
}

test('initData：hash 改大写 → 仍通过', async () => {
  assert.deepEqual(await verify(edit(good(), (p) => p.set('hash', p.get('hash').toUpperCase()))), OK);
});

// ---------- hash 正确，但内容不合格（签名有效也要挡） ----------
const drop = (key) => (f) => { delete f[key]; return f; };
const signedBad = {
  '缺 auth_date': drop('auth_date'),
  '缺 user': drop('user'),
  'user 不是 JSON': (f) => ({ ...f, user: '{id:1' }),
  'user 是 null': (f) => ({ ...f, user: 'null' }),
  'user 是阵列': (f) => ({ ...f, user: '[1,2]' }),
  'user 是数字': (f) => ({ ...f, user: '42' }),
  'user.id 是 -1': (f) => ({ ...f, user: JSON.stringify({ ...USER, id: -1 }) }),
  'user.id 是 0': (f) => ({ ...f, user: JSON.stringify({ ...USER, id: 0 }) }),
  'user.id 是 1.5': (f) => ({ ...f, user: JSON.stringify({ ...USER, id: 1.5 }) }),
  'user.id 是字串': (f) => ({ ...f, user: JSON.stringify({ ...USER, id: '987654321' }) }),
  'user.id 是 2**53': (f) => ({ ...f, user: '{"id":9007199254740992,"username":"alice"}' }),
  '缺 user.id': (f) => ({ ...f, user: JSON.stringify({ username: 'alice' }) }),
  'user.is_bot 是 true': (f) => ({ ...f, user: JSON.stringify({ ...USER, is_bot: true }) }),
  "auth_date 是 '12e3'": (f) => ({ ...f, auth_date: '12e3' }),
  'auth_date 是空字串': (f) => ({ ...f, auth_date: '' }),
  "auth_date 是 ' 123'": (f) => ({ ...f, auth_date: ' 1764000000' }),
  'auth_date 是 13 位数字': (f) => ({ ...f, auth_date: '1764000000000' }),
  'auth_date 太旧（now - maxAge - 1）': (f) => ({ ...f, auth_date: String(NOW - AGE - 1) }),
  'auth_date 在未来 61 秒': (f) => ({ ...f, auth_date: String(NOW + 61) }),
};
for (const [name, change] of Object.entries(signedBad)) {
  test(`initData 签名有效但内容不合格：${name} → null`, async () => {
    assert.deepEqual(await verify(good()), OK, '原资料要先能通过');
    assert.equal(await verify(signInitData(change(base()), TOKEN)), null);
  });
}

test('initData：auth_date 刚好 now - maxAge、或在未来 60 秒 → 通过', async () => {
  assert.deepEqual(await verify(signInitData(base({ auth_date: String(NOW - AGE) }), TOKEN)), OK);
  assert.deepEqual(await verify(signInitData(base({ auth_date: String(NOW + 60) }), TOKEN)), OK);
});

test('initData：user.is_bot 是 false → 通过', async () => {
  assert.deepEqual(await verify(signInitData(base({ user: JSON.stringify({ ...USER, is_bot: false }) }), TOKEN)), OK);
});

test('initData：user.id 超过 32 位（2**52 - 1）→ telegramId 是完整的十进位字串', async () => {
  const r = await verify(signInitData(base({ user: JSON.stringify({ ...USER, id: 2 ** 52 - 1 }) }), TOKEN));
  assert.deepEqual(r, { telegramId: '4503599627370495', label: '@alice' });
});

test('initData：值含空格、&、=、+、中文 → 通过（用的是解码后的值）；空格写成 %20 也一样', async () => {
  const s = signInitData(base({ query_id: 'a b&c=d+e 中文' }), TOKEN);
  assert.deepEqual(await verify(s), OK);
  assert.ok(s.includes('+'), '测试前提：URLSearchParams 把空格编成 +');
  assert.deepEqual(await verify(s.replace(/\+/g, '%20')), OK);
});

test('initData：长度 4096 → 通过；4097 → null', async () => {
  const len0 = signInitData(base({ pad: '' }), TOKEN).length;
  const at = (n) => signInitData(base({ pad: 'x'.repeat(n) }), TOKEN);
  assert.equal(at(4096 - len0).length, 4096);
  assert.deepEqual(await verify(at(4096 - len0)), OK);
  assert.equal(at(4097 - len0).length, 4097);
  assert.equal(await verify(at(4097 - len0)), null);
});

test('initData：不是字串或是空字串 → null', async () => {
  for (const v of [null, undefined, 42, '', {}]) assert.equal(await verify(v), null, String(v));
});

// ---------- 显示名 ----------
test('tgLabel：有 username → @username；没有就用名字', () => {
  assert.equal(tgLabel({ username: 'alice', first_name: 'Alice' }), '@alice');
  assert.equal(tgLabel({ first_name: 'Alice', last_name: 'Tan' }), 'Alice Tan');
  assert.equal(tgLabel({ username: '', first_name: 'Bob' }), 'Bob');
  assert.equal(tgLabel({ last_name: 'Tan' }), 'Tan');
  assert.equal(tgLabel({}), '');
});

test('tgLabel：最多 64 个码点，不切开表情符号', () => {
  assert.equal([...tgLabel({ first_name: '名'.repeat(70) })].length, 64);
  assert.equal(tgLabel({ first_name: '名'.repeat(63) + '😀' + '名' }), '名'.repeat(63) + '😀');
});

test('tgLabel：去掉控制字元、零宽字、方向字元；空白并成一个', () => {
  assert.equal(tgLabel({ first_name: 'A\nB\u200BC\u202ED\u0000E\u2066F' }), 'ABCDEF');
  assert.equal(tgLabel({ first_name: '  a   b  ' }), 'a b');
  assert.equal(tgLabel({ first_name: 'a\u3000\u3000b' }), 'a b');
});

test('tgLabel：截完 64 码点后尾巴是空白 → 去掉', () => {
  assert.equal(tgLabel({ first_name: '名'.repeat(63) + ' 尾巴' }), '名'.repeat(63));
});

test('initData：label 跟着 tgLabel 规则（没有 username 时用名字）', async () => {
  const r = await verify(signInitData(base({ user: JSON.stringify({ id: 5, first_name: 'Ali\u202Ece' }) }), TOKEN));
  assert.deepEqual(r, { telegramId: '5', label: 'Alice' });
});

// ---------- 打包规则 ----------
test('telegram.ts 符合 _shared 打包规则：不 import 别档；顶层名字都以 tg 开头（不分大小写）', () => {
  const src = readFileSync(new URL('../supabase/functions/_shared/telegram.ts', import.meta.url), 'utf8');
  assert.equal(SHARED_IMPORT_FORBIDDEN.test(src), false);
  const names = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  assert.ok(names.length >= 4, '至少要找到 4 个顶层名字');
  for (const n of names) assert.match(n, /^tg/i, n);
});
