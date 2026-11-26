// 2d：登录画面的纯函数与 CSS 规则（DOM 部分靠 headless 与 iPhone 实测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyboardLift, codeCells, splitTail, makeErrorWriter, LOGIN_TEXT, linkLeadParts, loginExtras, askReset, ENTRANCE, entranceKeyframes, entrancePlan } from '../js/ui/login.js';
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
  assert.equal(LOGIN_TEXT.welcomeTitle, '我的小账本');   // 3c-1 用户定稿
  assert.equal(LOGIN_TEXT.brandName, '记账');
  assert.ok(!('welcomeSub' in LOGIN_TEXT) && !('welcomeSubTail' in LOGIN_TEXT), '欢迎页不再有副标题');
  assert.equal(LOGIN_TEXT.welcomeFoot, '第一次使用需要邀请码');
  assert.equal(LOGIN_TEXT.welcomeButton, '用邮箱登录');
  assert.equal(LOGIN_TEXT.inviteLabel, '邀请码（第一次使用才需要）');
  assert.equal(LOGIN_TEXT.invitePlaceholder, '例如 K7MP-Q4XZ');
  assert.equal(LOGIN_TEXT.sendButton, '发送验证码');
  assert.equal(LOGIN_TEXT.codeButton, '进入记账');
  assert.equal(LOGIN_TEXT.sentTo('me@x.com'), '已寄到 me@x.com，10 分钟内有效。');
  assert.equal(LOGIN_TEXT.resendIn(42), '没收到？42 秒后可以重新发送');
});

test('splitTail：句尾那一段拆出来（整组不断行）；对不上就原样', () => {
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
  assert.match(s, /class: 'wl-hero', 'aria-hidden': 'true'/);   // 示例卡（假金额）对读屏隐藏
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

test('CSS：欢迎页光球在增加对比度 / 降低透明度时关掉，示例卡改实心', () => {
  const block = (css.match(/@media \(prefers-contrast: more\), \(prefers-reduced-transparency: reduce\)\s*\{([^@]*?)\n\}/g) || []).join('\n');
  assert.match(block, /\.wl-hero::before[^{]*\{\s*display\s*:\s*none/, '光球关掉');
  assert.match(block, /\.wl-card,\s*\.wl-tx\s*\{[^}]*background\s*:\s*var\(--drawer\)/, '两种卡都改实心');
  assert.match(block, /\.wl-card::before\s*\{\s*display\s*:\s*none/, '渐层反光边关掉');
  assert.match(block, /\.wl-layer-tx2 \.wl-tx\s*\{[^}]*opacity\s*:\s*1/, '后面那张不再半透明');
});

// ---------- 3c-1 欢迎页 ----------
test('进场动画：每段 0.15–0.25 秒，依序错开，只动 opacity / transform', () => {
  assert.ok(ENTRANCE.duration >= 150 && ENTRANCE.duration <= 250, String(ENTRANCE.duration));
  assert.deepEqual(ENTRANCE.delays, [0, 40, 80, 120, 150, 180]);
  const kf = entranceKeyframes();
  assert.equal(kf.length, 2);
  for (const f of kf) assert.deepEqual(Object.keys(f).sort(), ['opacity', 'transform']);
  assert.equal(kf[0].opacity, 0);
  assert.equal(kf[1].opacity, 1);
});

test('entrancePlan：只在一挂上就是欢迎页时播；减少动态改整页淡入；其他情况不播', () => {
  assert.equal(entrancePlan({ prevStep: null, step: 'welcome', reduced: false }), 'stagger');
  assert.equal(entrancePlan({ prevStep: null, step: 'welcome', reduced: true }), 'fade');
  assert.equal(entrancePlan({ prevStep: 'email', step: 'welcome', reduced: false }), 'none');   // 从邮箱页返回：照旧淡入
  assert.equal(entrancePlan({ prevStep: 'link', step: 'welcome', reduced: false }), 'none');    // Telegram 取消连接后回欢迎页
  assert.equal(entrancePlan({ prevStep: null, step: 'email', reduced: false }), 'none');        // 开机恢复到邮箱页
  assert.equal(entrancePlan({ prevStep: null, step: 'code', reduced: false }), 'none');
  assert.equal(ENTRANCE.delays.length, 6, '6 个目标：品牌、结余卡、两张账单卡、标题、按钮区');
});

test('login.js：欢迎页旧插图已拿掉；render 照 entrancePlan 播；标题保留焦点与读屏用的 id', () => {
  const s = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /heroArt|HERO_PARTS|SVG_NS|svgEl|login-art|login-halo|'la-/);
  assert.match(s, /entrancePlan\(\{ prevStep, step, reduced: reducedMotion\(\) \}\)/);
  assert.match(s, /id: 'login-title-welcome', tabindex: '-1'/);
  assert.match(s, /'aria-labelledby': 'login-title-welcome'/);
  assert.doesNotMatch(s, /welcomeTitle\.split/);
});

test('login.js：render 照 entrancePlan 真的播；进场目标正好 6 个、不含外层 hero（动外层会把光球带到文字上面）', () => {
  const s = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.match(s, /if \(entry !== 'none'\) playEntrance\(entry\);/);
  const m = s.match(/\[([^\]]*)\]\.forEach\(\(node, i\) => animate\(node, entranceKeyframes\(\)/);
  assert.ok(m, '找得到进场目标清单');
  assert.deepEqual(m[1].split(',').map((x) => x.trim()), ['brand', 'hero.card', 'hero.tx1', 'hero.tx2', 'welcomeTitle', 'welcomeCta']);
});

test('CSS：旧插图样式与 token 已清掉', () => {
  assert.doesNotMatch(css, /\.la-|\.login-halo|\.login-art|--coin\b|--login-sheen|--login-halo|@keyframes rise/);
});

test('CSS：欢迎页规则没有模糊、will-change、CSS 动画', () => {
  const rules = rulesMatching(/\.wl-/);
  assert.ok(rules.length > 5, '找得到 .wl- 规则');
  for (const r of rules) {
    assert.doesNotMatch(r.body, /backdrop-filter|filter\s*:|blur\(|will-change|animation\s*:|position\s*:\s*fixed/, r.sel);
    // 起点只靠 WAAPI 的 fill: backwards：动画不支援或出错时内容照常显示，基础样式不能先藏起来
    assert.doesNotMatch(r.body, /opacity\s*:\s*0(?![.\d])|visibility\s*:\s*hidden/, r.sel);
  }
  // 示例卡是插图：字级用 px，不跟 Dynamic Type 放大（舞台固定高，放大会撑破）
  for (const r of rulesMatching(/\.wl-(card|amt|flow|bar|tx)/)) assert.doesNotMatch(r.body, /\d(\.\d+)?rem|var\(--font-(?!family)/, r.sel);
});

test('CSS：光球在最底层、不盖文字（欢迎页隔离层叠，光球 z-index -1），左右伸到屏幕边', () => {
  const [w] = rulesMatching(/^\.login-welcome$/);
  assert.match(w.body, /isolation\s*:\s*isolate/);
  const [o] = rulesMatching(/^\.wl-hero::before$/);
  assert.ok(o, '.wl-hero::before 存在');
  assert.match(o.body, /z-index\s*:\s*-1/);
  assert.match(o.body, /pointer-events\s*:\s*none/);
  assert.match(o.body, /left\s*:\s*calc\(-1 \* \(24px \+ var\(--safe-left\)\)\)/);
  assert.match(o.body, /right\s*:\s*calc\(-1 \* \(24px \+ var\(--safe-right\)\)\)/);
  // 每个光球纵向都在框里淡完（70% 半径），不会切出横边
  const hgt = Number(o.body.match(/height\s*:\s*(\d+)px/)[1]);
  const orbs = [...o.body.matchAll(/radial-gradient\((\d+)px (\d+)px at [\d.]+% (\d+)px, var\(--orb-\d\), transparent 70%\)/g)];
  assert.equal(orbs.length, 4);
  for (const [, , ry, y] of orbs) {
    assert.ok(Number(y) - 0.7 * Number(ry) >= 0, `上缘 ${y}`);
    assert.ok(Number(y) + 0.7 * Number(ry) <= hgt, `下缘 ${y}`);
  }
  // 光球挂在 .wl-hero 上：.wl-hero 本身不能建层叠上下文（否则光球会困在里面、整层画到标题上面）
  for (const r of rulesMatching(/^\.wl-hero$/)) assert.doesNotMatch(r.body, /z-index|isolation|transform|opacity|filter/, r.sel);
});

test('CSS：矮屏收起后面那张账单卡', () => {
  const m = css.match(/@media \(max-height: 700px\)\s*\{[^@]*\.wl-layer-tx2\s*\{\s*display\s*:\s*none/);
  assert.ok(m, '矮屏规则存在');
});

test('CSS：很矮的屏（Safari 分页＋提示、SE）示例卡整组缩小，按钮与脚注不被挤出屏幕', () => {
  const m = css.match(/@media \(max-height: 600px\)\s*\{[^@]*\.wl-stage\s*\{[^}]*transform\s*:\s*scale\(0\.8\d?\)[^}]*margin\s*:\s*-\d+px 0/);
  assert.ok(m, '很矮屏规则存在');
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

test('审核：askReset exportable:false（Telegram 里）→ 没有「导出 CSV」，内文不提导出', async () => {
  let seen = null;
  const r = await askReset({}, { txCount: 2 }, {
    exportable: false,
    choice: async (o) => { seen = o; return 'cancel'; },
    confirm: async () => true,
    exporter: () => () => {},
  });
  assert.equal(r, false);
  assert.deepEqual(seen.buttons.map((b) => b.label), [LOGIN_TEXT.switchClear, LOGIN_TEXT.switchCancel]);
  assert.doesNotMatch(seen.message, /导出/);
});
