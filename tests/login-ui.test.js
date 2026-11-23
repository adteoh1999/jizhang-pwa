// 2d：登录画面的纯函数与 CSS 规则（DOM 部分靠 headless 与 iPhone 实测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyboardLift, codeCells, LOGIN_TEXT } from '../js/ui/login.js';
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

test('CSS：.login 本身不是贴顶、有底色的 fixed 层（状态栏方案 B：底色由 .sky 提供）', () => {
  for (const r of rulesMatching(/(^|,)\s*\.login\s*(,|$)/)) {
    assert.doesNotMatch(r.body, /position\s*:\s*fixed/, r.sel);
    assert.doesNotMatch(r.body, /background/, r.sel);
  }
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

test('login.js 不打印 session 或 token', () => {
  const s = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /console\.log\(/);
  assert.doesNotMatch(s, /console\.\w+\([^)]*(session|token)/i);
});
