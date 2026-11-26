// 2d：登录画面的纯函数与 CSS 规则（DOM 部分靠 headless 与 iPhone 实测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyboardLift, codeCells, splitTail, makeErrorWriter, LOGIN_TEXT, linkLeadParts, loginExtras } from '../js/ui/login.js';
import { css } from './helpers/css-tokens.js';

const base = { blockTop: 300, currentLift: 0, vvOffsetTop: 0, minTop: 60 };

test('keyboardLift：键盘没挡到 → 0', () => {
  assert.equal(keyboardLift({ ...base, blockBottom: 400, vvHeight: 520 }), 0);
  assert.equal(keyboardLift({ ...base, blockBottom: 700, vvHeight: 844 }), 0);
});

test('keyboardLift：挡到 → 往上移刚好露出（留 12px）', () => {
  assert.equal(keyboardLift({ ...base, blockBottom: 560, vvHeight: 520 }), 52);
  assert.equal(keyboardLift({ ...base, blockBottom: 560, vvHeight: 520, vvOffsetTop: 30 }), 22);
  assert.equal(keyboardLift({ ...base, blockBottom: 560, vvHeight: 520, gap: 20 }), 60);
});

test('keyboardLift：已经上移过再量一次，结果不变（量到的位置已含位移）', () => {
  assert.equal(keyboardLift({ ...base, blockTop: 248, blockBottom: 508, currentLift: 52, vvHeight: 520 }), 52);
});

test('keyboardLift：正在输入的栏位不会被推出可见范围（留 8px）', () => {
  assert.equal(keyboardLift({ ...base, blockTop: 100, blockBottom: 700, vvHeight: 400, minTop: 0, focusTop: 80 }), 72);
  assert.equal(keyboardLift({ ...base, blockTop: 100, blockBottom: 700, vvHeight: 400, focusTop: 120 }), 40);
  // 已上移 40 再量：结果不变
  assert.equal(keyboardLift({ ...base, blockTop: 60, blockBottom: 660, currentLift: 40, vvHeight: 400, focusTop: 80 }), 40);
});

test('keyboardLift：最多移到表单顶端碰到 minTop 为止', () => {
  assert.equal(keyboardLift({ ...base, blockTop: 100, blockBottom: 700, vvHeight: 400 }), 40);
  assert.equal(keyboardLift({ ...base, blockTop: 50, blockBottom: 700, vvHeight: 400 }), 0);
});

test('codeCells：6 格，下一个要输入的那格 active；满了没有 active', () => {
  const c = codeCells('481');
  assert.equal(c.length, 6);
  assert.deepEqual(c.map((x) => x.v), ['4', '8', '1', '', '', '']);
  assert.deepEqual(c.map((x) => x.active), [false, false, false, true, false, false]);
  assert.ok(codeCells('481203').every((x) => !x.active));
  assert.deepEqual(codeCells('').map((x) => x.active), [true, false, false, false, false, false]);
});

test('文字照预览', () => {
  assert.equal(LOGIN_TEXT.welcomeTitle, '每一笔钱，都记得清清楚楚');
  assert.equal(LOGIN_TEXT.welcomeButton, '用邮箱登录');
  assert.equal(LOGIN_TEXT.inviteLabel, '邀请码（第一次使用才需要）');
  assert.equal(LOGIN_TEXT.invitePlaceholder, '例如 K7MP-Q4XZ');
  assert.equal(LOGIN_TEXT.sendButton, '发送验证码');
  assert.equal(LOGIN_TEXT.codeButton, '进入记账');
  assert.equal(LOGIN_TEXT.sentTo('me@x.com'), '已寄到 me@x.com，10 分钟内有效。');
  assert.equal(LOGIN_TEXT.resendIn(42), '没收到？42 秒后可以重新发送');
});

test('splitTail：句尾那一段拆出来（整组不断行）；对不上就原样', () => {
  assert.deepEqual(splitTail(LOGIN_TEXT.welcomeSub, LOGIN_TEXT.welcomeSubTail), ['手机和 Telegram 共用同一本账，', '换设备也不会丢。']);
  assert.deepEqual(splitTail(LOGIN_TEXT.emailSub, LOGIN_TEXT.emailSubTail), ['我们会寄一组 6 位数验证码', '到你的邮箱。']);
  assert.deepEqual(splitTail(LOGIN_TEXT.sentTo('me@x.com'), LOGIN_TEXT.sentToTail), ['已寄到 me@x.com，', '10 分钟内有效。']);
  assert.deepEqual(splitTail('别的句子', '有效。'), ['别的句子', null]);
  assert.deepEqual(splitTail('有效。', '有效。'), ['有效。', null]);
});

test('login.js：邮箱、邀请码一改动就通知流程清掉该栏位的错误', () => {
  const s = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.match(s, /emailInput\.addEventListener\('input', \(\) => flow\.editField\('email'\)\)/);
  assert.match(s, /inviteInput\.addEventListener\('input', \(\) => flow\.editField\('invite'\)\)/);
});

test('CSS：说明文字里不断行的那段，过宽时仍可在段内换行（不撑出横向卷动）', () => {
  const [r] = rulesMatching(/^\.login-sub \.nowrap$/);
  assert.ok(r, '.login-sub .nowrap 规则存在');
  assert.match(r.body, /display\s*:\s*inline-block/);
  assert.match(r.body, /white-space\s*:\s*normal/);
});

function fakeTimers() {
  const q = [];
  return { schedule: (fn) => q.push(fn), flush: () => { while (q.length) q.shift()(); } };
}

test('makeErrorWriter：同一句再出现 → 先清空、稍后写回（会重念）', () => {
  const t = fakeTimers();
  const say = makeErrorWriter({ schedule: t.schedule });
  const node = { textContent: '' };
  say(node, '请输入正确的邮箱', true);
  assert.equal(node.textContent, '请输入正确的邮箱');
  say(node, '请输入正确的邮箱', true);
  assert.equal(node.textContent, '');
  t.flush();
  assert.equal(node.textContent, '请输入正确的邮箱');
});

test('makeErrorWriter：延迟写回期间错误被清掉 → 旧句子不会复活（审核必须改）', () => {
  const t = fakeTimers();
  const say = makeErrorWriter({ schedule: t.schedule });
  const node = { textContent: '请输入正确的邮箱' };
  say(node, '请输入正确的邮箱', true);  // 再按一次送出：清空、排程写回
  say(node, '', false);                 // 60ms 内打字：错误清掉（节点本来就是空的）
  t.flush();
  assert.equal(node.textContent, '');
});

test('makeErrorWriter：页面已关掉 → 不写回', () => {
  const t = fakeTimers();
  let alive = true;
  const say = makeErrorWriter({ schedule: t.schedule, alive: () => alive });
  const node = { textContent: 'X' };
  say(node, 'X', true);
  alive = false;
  t.flush();
  assert.equal(node.textContent, '');
});

// ---------- CSS ----------
function rulesMatching(re) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] })).filter((r) => re.test(r.sel));
}

test('CSS：登录页规则没有模糊、will-change、持续动画', () => {
  const rules = rulesMatching(/\.login/);
  assert.ok(rules.length > 5, '找得到 .login 规则');
  for (const r of rules) {
    assert.doesNotMatch(r.body, /backdrop-filter|blur\(|will-change|animation\s*:/, r.sel);
  }
});

test('CSS：登录页没有 fixed 层；.login 本身没有底色（状态栏方案 B：底色由 .sky 提供）', () => {
  for (const r of rulesMatching(/\.login/)) assert.doesNotMatch(r.body, /position\s*:\s*fixed/, r.sel);
  for (const r of rulesMatching(/(^|,)\s*\.login\s*(,|$)/)) assert.doesNotMatch(r.body, /background/, r.sel);
});

test('CSS：错误栏位用 [aria-invalid="true"]；占位字用 --ink-2', () => {
  assert.ok(rulesMatching(/\.login-input\[aria-invalid="true"\]/).length === 1);
  const [ph] = rulesMatching(/\.login-input::placeholder/);
  assert.match(ph.body, /color\s*:\s*var\(--ink-2\)/);
  assert.doesNotMatch(ph.body, /opacity\s*:\s*0\./);
});

test('login.js：插图对读屏隐藏；aria-invalid 设成字串 "true"，不用 toggleAttribute', () => {
  const s = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.match(s, /class: 'login-art', 'aria-hidden': 'true'/);
  assert.doesNotMatch(s, /toggleAttribute\('aria-invalid'/);
  assert.match(s, /setAttribute\('aria-invalid', 'true'\)/);
});

test('CSS：验证码输入框是盖满 6 格的透明真实输入框，不是 display:none / 1px', () => {
  const [r] = rulesMatching(/^\.login-code-input$/);
  assert.ok(r, '.login-code-input 规则存在');
  assert.match(r.body, /position\s*:\s*absolute/);
  assert.match(r.body, /inset\s*:\s*0/);
  assert.match(r.body, /color\s*:\s*transparent/);
  assert.match(r.body, /caret-color\s*:\s*transparent/);
  assert.match(r.body, /font-size\s*:\s*(1[6-9]|[2-9]\d)px/);
  assert.doesNotMatch(r.body, /display\s*:\s*none|width\s*:\s*1px|opacity\s*:\s*0(?![.\d])/);
});

test('CSS：光晕在增加对比度 / 降低透明度时关掉', () => {
  const m = css.match(/@media \(prefers-contrast: more\), \(prefers-reduced-transparency: reduce\)\s*\{[^@]*\.login-halo[^}]*display\s*:\s*none/);
  assert.ok(m, '.login-halo 有后备');
});

test('登录相关的 js 不打印 session 或 token', () => {
  for (const f of ['../js/ui/login.js', '../js/login-flow.js', '../js/app.js', '../js/ui/settings.js', '../js/auth.js']) {
    const s = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /console\.log\(/, f);
    assert.doesNotMatch(s, /console\.\w+\([^)]*(session|token|refresh|access)/i, f);
  }
});


// ---------- 3b-8：连接 Telegram 画面 ----------
test('连接画面文字（r1-M1c）', () => {
  assert.equal(LOGIN_TEXT.linkTitle, '连接 Telegram');
  assert.equal(LOGIN_TEXT.linkNote, '连接后，这个 Telegram 账号可以直接打开、修改这本账。只连接你自己的 Telegram。');
  assert.equal(LOGIN_TEXT.linkButton, '连接');
  assert.equal(LOGIN_TEXT.linking, '正在连接…');
  assert.equal(LOGIN_TEXT.linkCancel, '取消');
  assert.equal(LOGIN_TEXT.tgEmailHint, '登录后会连接到这个 Telegram。');
});

test('linkLeadParts：「要把 Telegram 用户 ＜名字＞ 连接到 ＜邮箱＞ 吗？」，名字与邮箱是粗体片段', () => {
  const parts = linkLeadParts('@zed', 'me@x.com');
  assert.equal(parts.map((p) => p.text).join(''), '要把 Telegram 用户 @zed 连接到 me@x.com 吗？');
  assert.deepEqual(parts.filter((p) => p.strong).map((p) => p.text), ['@zed', 'me@x.com']);
});

test('linkLeadParts：名字含 <b> 等符号 → 原样当文字（不解析）；名字空或只有空白 → 「这个 Telegram」', () => {
  const evil = linkLeadParts('<b>x</b><img src=x>', 'me@x.com');
  assert.equal(evil.find((p) => p.strong).text, '<b>x</b><img src=x>');
  for (const label of ['', '   ', null, undefined]) {
    const parts = linkLeadParts(label, 'me@x.com');
    assert.equal(parts.map((p) => p.text).join(''), '要把这个 Telegram 连接到 me@x.com 吗？', String(label));
    assert.deepEqual(parts.filter((p) => p.strong).map((p) => p.text), ['这个 Telegram', 'me@x.com']);
  }
});

test('login.js：不用 innerHTML（Telegram 名字一律当文字）', () => {
  const src = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('loginExtras：Telegram 模式不显示 Safari 提示、邮箱页多一句连接提示；PWA 照旧', () => {
  assert.deepEqual(loginExtras({ telegram: true, iosTab: true }), { safari: false, tgHint: true });
  assert.deepEqual(loginExtras({ telegram: true, iosTab: false }), { safari: false, tgHint: true });
  assert.deepEqual(loginExtras({ telegram: false, iosTab: true }), { safari: true, tgHint: false });
  assert.deepEqual(loginExtras({ telegram: false, iosTab: false }), { safari: false, tgHint: false });
});
