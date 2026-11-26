// 登录画面：欢迎 → 邮箱（＋邀请码）→ 6 位数验证码 →（Telegram 模式）确认连接。照登录页预览（晨雾背景、静态光晕、钱包硬币插图、按钮紧跟输入框）。
// 流程逻辑都在 js/login-flow.js；这里只负责画、绑事件、键盘、倒数。
// 规则：DOM 一次建好，状态变化只改文字与属性，不重建输入框（内容、焦点、键盘不丢）。
import { h } from './dom.js';
import { icon } from './icons.js';
import { isIosBrowserTab } from './install-hint.js';
import { confirmDialog, choiceDialog } from './dialogs.js';
import { createExporter } from './export-csv.js';
import { fade, reducedMotion } from './motion.js';
import { announce } from './announce.js';
import { onDepthChange } from './nav.js';
import { createLoginFlow } from '../login-flow.js';
import { registerEmail, requestOtp, verifyOtp, logoutServer } from '../auth.js';
import { announceLedgerReset } from '../ledger-channel.js';

export const LOGIN_TEXT = Object.freeze({
  welcomeTitle: '每一笔钱，都记得清清楚楚',
  welcomeSub: '手机和 Telegram 共用同一本账，换设备也不会丢。',
  welcomeSubTail: '换设备也不会丢。', // 换行时整组移到下一行，不留「会丢。」落单、不拆开「换设备」
  welcomeButton: '用邮箱登录',
  welcomeFoot: '第一次使用需要邀请码',
  emailTitle: '登录',
  emailSub: '我们会寄一组 6 位数验证码到你的邮箱。',
  emailSubTail: '到你的邮箱。',
  emailLabel: '邮箱',
  inviteLabel: '邀请码（第一次使用才需要）',
  invitePlaceholder: '例如 K7MP-Q4XZ',
  inviteHint: '已经注册过的邮箱，不用再填。',
  sendButton: '发送验证码',
  sending: '正在发送…',
  codeTitle: '输入验证码',
  codeLabel: '6 位数验证码',
  codeAuto: '输满 6 位会自动登录。',
  codeButton: '进入记账',
  signingIn: '正在登录…',
  resendButton: '重新发送验证码',
  safariHint: '请先加到主屏幕再使用：点 分享 → 添加到主屏幕。在这里登录后，加到主屏幕还要再登录一次。',
  switchTitle: (n) => (n > 0 ? `还有 ${n} 笔记录没上传` : '还有没上传的改动'),
  switchMessage: '换成新账号会清除这台设备上的账本。已上传的记录还在原来的账号里，没上传的会消失。可以先导出 CSV，或取消后用原来的账号登录、等它上传完。',
  switchExport: '导出 CSV',
  switchClear: '清除并登录',
  switchCancel: '取消登录',
  clearTitle: '清除没上传的记录？',
  clearMessage: 'CSV 存好了吗？清除后无法恢复。',
  clearConfirm: '清除',
  sentTo: (email) => `已寄到 ${email}，10 分钟内有效。`,
  sentToTail: '10 分钟内有效。',
  resendIn: (sec) => `没收到？${sec} 秒后可以重新发送`,
  // 3b-8：Telegram 模式
  linkTitle: '连接 Telegram',
  linkNote: '连接后，这个 Telegram 账号可以直接打开、修改这本账。只连接你自己的 Telegram。',
  linkButton: '连接',
  linking: '正在连接…',
  linkCancel: '取消',
  tgEmailHint: '登录后会连接到这个 Telegram。',
  tgNameFallback: '这个 Telegram',
});

/**
 * 连接确认句的片段：「要把 Telegram 用户 ＜名字＞ 连接到 ＜邮箱＞ 吗？」（名字空 →「要把这个 Telegram 连接到…」）。
 * 回 [{text, strong?}]；名字是对方填的，画的时候一律当文字（h() 用 text node），不解析。
 */
export function linkLeadParts(label, email) {
  const name = typeof label === 'string' ? label.trim() : '';
  const lead = name
    ? [{ text: '要把 Telegram 用户 ' }, { text: name, strong: true }, { text: ' 连接到 ' }]
    : [{ text: '要把' }, { text: LOGIN_TEXT.tgNameFallback, strong: true }, { text: ' 连接到 ' }];
  return [...lead, { text: email, strong: true }, { text: ' 吗？' }];
}

/** 平台不同时多／少显示的东西：Telegram 里没有「加到主屏幕」这回事，邮箱页改提示会连接这个 Telegram。 */
export function loginExtras({ telegram, iosTab }) {
  return { safari: !telegram && !!iosTab, tgHint: !!telegram };
}

/**
 * 键盘挡住表单时要往上移多少 px（纯函数）。
 * blockTop / blockBottom / focusTop：表单块与正在输入的栏位「现在量到」的位置（已含目前实际的位移 currentLift）；
 * 可见范围是 [vvOffsetTop, vvOffsetTop + vvHeight]。上限：表单顶端不高于 minTop，
 * 而且正在输入的栏位顶端不能被推出可见范围（留 8px）——大字级 + 小屏幕时优先让输入框看得到。
 */
export function keyboardLift({ blockTop, blockBottom, currentLift = 0, vvHeight, vvOffsetTop = 0, minTop = 0, focusTop = null, gap = 12 }) {
  const top = blockTop + currentLift;
  const bottom = blockBottom + currentLift;
  const need = bottom + gap - (vvOffsetTop + vvHeight);
  if (need <= 0) return 0;
  let cap = top - minTop;
  if (Number.isFinite(focusTop)) cap = Math.min(cap, focusTop + currentLift - (vvOffsetTop + 8));
  return Math.max(0, Math.min(need, cap));
}

/**
 * 错误区写入器（可注入计时器，方便测试）。fresh：同一句再出现也要重念（先清空、delay 后写回）。
 * 每次调用都作废还没写回的那一次——包括「目标文字和现在一样」直接返回的情况：
 * 否则延迟写回期间错误被清掉（节点本来就是空的），旧句子仍会在 delay 后复活。
 */
export function makeErrorWriter({ alive = () => true, delay = 60, schedule = setTimeout } = {}) {
  let seq = 0;
  return function sayError(node, text, fresh) {
    const my = ++seq;
    if (!fresh && node.textContent === text) return;
    if (fresh && text && node.textContent === text) {
      node.textContent = '';
      schedule(() => { if (alive() && my === seq) node.textContent = text; }, delay);
      return;
    }
    node.textContent = text;
  };
}

/** 把句尾 tail 拆出来（整组不断行用）：[前段, tail]；句子不是以 tail 结尾、或整句就是 tail → [原句, null]。 */
export function splitTail(text, tail) {
  if (typeof text !== 'string' || !tail || text === tail || !text.endsWith(tail)) return [text, null];
  return [text.slice(0, -tail.length), tail];
}

/** 验证码 6 格的显示内容：下一个要输入的那格 active。 */
export function codeCells(code) {
  const s = typeof code === 'string' ? code : '';
  return Array.from({ length: 6 }, (_, i) => ({ v: s[i] || '', active: i === s.length }));
}

// 原创插图：毛玻璃钱包＋两枚硬币（照预览；静态 SVG，没有动画）。逐个 createElementNS，不用 HTML 字串。
const SVG_NS = 'http://www.w3.org/2000/svg';
const HERO_PARTS = [
  ['circle', { class: 'la-coin', cx: 98, cy: 70, r: 40 }],
  ['circle', { class: 'la-ring', cx: 98, cy: 70, r: 29 }],
  ['text', { class: 'la-ink', x: 98, y: 77, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 800 }, 'RM'],
  ['circle', { class: 'la-coin', cx: 160, cy: 54, r: 32 }],
  ['circle', { class: 'la-ring', cx: 160, cy: 54, r: 22 }],
  ['path', { class: 'la-arrow', d: 'M160 42 v24 M152 48 l8 -6 l8 6' }],
  ['rect', { class: 'la-wallet', x: 34, y: 92, width: 192, height: 124, rx: 28 }],
  ['rect', { class: 'la-sheen', x: 34, y: 92, width: 192, height: 124, rx: 28, fill: 'url(#login-sheen)' }],
  ['path', { class: 'la-edge', d: 'M34 132 h132 a22 22 0 0 1 22 22 v0 a22 22 0 0 1 -22 22 h-132' }],
  ['rect', { class: 'la-fill', x: 150, y: 136, width: 60, height: 36, rx: 18 }],
  ['circle', { class: 'la-clasp', cx: 170, cy: 154, r: 7 }],
];
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text) n.textContent = text;
  return n;
}
function heroArt() {
  const svg = svgEl('svg', { class: 'login-art', 'aria-hidden': 'true', width: 260, height: 230, viewBox: '0 0 260 230' });
  const grad = svgEl('linearGradient', { id: 'login-sheen', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(svgEl('stop', { class: 'la-sheen-top', offset: 0 }), svgEl('stop', { class: 'la-sheen-end', offset: 0.5 }));
  const defs = svgEl('defs', {});
  defs.append(grad);
  svg.append(defs, ...HERO_PARTS.map(([tag, attrs, text]) => svgEl(tag, attrs, text)));
  return svg;
}

/**
 * 换账号、本地还有没上传的记录（审核 M5）：先「导出 CSV」（在点击里直接导出、不关窗），
 * 再「清除并登录」→ 第二个破坏性确认；第二个按取消 → 回到第一个。回 true = 清除。
 */
export async function askReset(store, { txCount }, { choice = choiceDialog, confirm = confirmDialog, exporter = createExporter } = {}) {
  const T = LOGIN_TEXT;
  const exportCsv = exporter(store);
  // 先收起键盘：关对话框时焦点回到验证码栏，iOS 会在两个对话框之间弹一下键盘（审核 S-6）
  if (globalThis.document && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  for (;;) {
    const v = await choice({
      title: T.switchTitle(txCount),
      message: T.switchMessage,
      // 直排三个：建议动作（导出）最上、红字清除、取消在最下且有焦点（Enter 不会直接清除）
      buttons: [
        { label: T.switchExport, bold: true, keepOpen: true, onClick: exportCsv },
        { label: T.switchClear, destructive: true, value: 'clear' },
        { label: T.switchCancel, value: 'cancel', focus: true },
      ],
    });
    if (v !== 'clear') return false;
    if (await confirm({ title: T.clearTitle, message: T.clearMessage, confirmLabel: T.clearConfirm, destructive: true })) return true;
  }
}

/**
 * 挂载登录画面。store：读写 meta、换账号时导出与清除；fetchFn：fetch；onSignedIn(session)。
 * 回 { destroy() }。登录成功时会先自动 destroy 再叫 onSignedIn。
 */
export function mountLogin(root, { store, fetchFn, onSignedIn, now = () => Date.now(), telegram = null }) {
  const T = LOGIN_TEXT;
  const cleanups = [];
  let destroyed = false;
  let timer = null;
  let lift = 0;
  let prevStep = null;

  const flow = createLoginFlow({
    api: {
      registerEmail: (email, invite) => registerEmail(fetchFn, email, invite),
      requestOtp: (email) => requestOtp(fetchFn, email),
      verifyOtp: (email, code, nowMs) => verifyOtp(fetchFn, email, code, nowMs),
      discardSession: (s) => logoutServer(fetchFn, s.access_token),
    },
    store,
    now,
    confirmReset: (info) => askReset(store, info),
    onReset: announceLedgerReset,
    onSignedIn: (s) => { destroy(); onSignedIn(s); },
    telegram,
  });
  const extras = loginExtras({ telegram, iosTab: isIosBrowserTab() });

  // ---------- 共用小件 ----------
  const primary = (label, attrs = {}) => h('button', { class: 'login-primary pressable', ...attrs }, label);
  const backBtn = (label) => h('button', { type: 'button', class: 'login-back pressable', 'aria-label': label, on: { click: () => flow.back() } }, icon('chevron-left', 24));
  const statusRows = () => ({
    notice: h('p', { class: 'login-notice' }),   // 提示改走 announce()，这里不设 aria-live（免得念两次）
    error: h('p', { class: 'login-error', role: 'alert' }),
  });
  // 句尾那一段包成 .nowrap（过宽时 CSS 仍让它在段内换行）
  const withTail = (text, tail) => {
    const [head, t] = splitTail(text, tail);
    return t ? [head, h('span', { class: 'nowrap' }, t)] : [head];
  };
  const safariHint = () => (extras.safari
    ? h('div', { class: 'install-hint login-hint', role: 'note' },
      h('span', { class: 'install-hint-icon' }, icon('square-arrow-up', 20)),
      h('p', { class: 'install-hint-text' }, T.safariHint))
    : null);

  // ---------- 1. 欢迎 ----------
  const hero = h('div', { class: 'login-hero' }, h('div', { class: 'login-halo', 'aria-hidden': 'true' }), heroArt());
  const [t1, t2] = T.welcomeTitle.split('，');
  const welcomeTitle = h('h1', { class: 'login-title login-title-welcome', id: 'login-title-welcome', tabindex: '-1' }, `${t1}，`, h('br'), t2);
  const welcome = h('section', { class: 'login-step login-welcome', 'data-step': 'welcome', 'aria-labelledby': 'login-title-welcome' },
    safariHint(),
    hero,
    h('div', { class: 'login-welcome-text' }, welcomeTitle, h('p', { class: 'login-sub' }, withTail(T.welcomeSub, T.welcomeSubTail))),
    primary(T.welcomeButton, { type: 'button', on: { click: () => flow.goEmail() } }),
    h('p', { class: 'login-footnote' }, T.welcomeFoot));

  // ---------- 2. 邮箱 ----------
  const emailInput = h('input', {
    class: 'login-input', id: 'login-email', type: 'email', inputmode: 'email', autocomplete: 'email',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', placeholder: 'you@example.com',
  });
  const inviteInput = h('input', {
    class: 'login-input login-input-invite', id: 'login-invite', type: 'text', autocomplete: 'off',
    autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send', placeholder: T.invitePlaceholder,
  });
  const emailStatus = statusRows();
  const sendBtn = primary(T.sendButton, { type: 'submit' });
  const emailTitle = h('h1', { class: 'login-title', id: 'login-title-email', tabindex: '-1' }, T.emailTitle);
  const emailForm = h('form', { class: 'login-form', novalidate: true },
    h('label', { class: 'login-field', for: 'login-email' }, h('span', { class: 'login-label' }, T.emailLabel)),
    emailInput,
    h('label', { class: 'login-field', for: 'login-invite' }, h('span', { class: 'login-label' }, T.inviteLabel)),
    inviteInput,
    h('p', { class: 'login-field-hint', id: 'login-invite-hint' }, T.inviteHint),
    emailStatus.notice, emailStatus.error, sendBtn);
  inviteInput.setAttribute('aria-describedby', 'login-invite-hint');
  // 邮箱栏按「下一个」跳到邀请码，不直接送出
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); inviteInput.focus(); }
  });
  // 改动出错的栏位：红字与红框立刻消失（不用等再按一次送出）
  emailInput.addEventListener('input', () => flow.editField('email'));
  inviteInput.addEventListener('input', () => flow.editField('invite'));
  emailForm.addEventListener('submit', (e) => { e.preventDefault(); flow.submitEmail(emailInput.value, inviteInput.value); });
  // Safari 提示放在 .login-body 里：键盘上移时和标题一起移动，不会叠在一起
  const emailBody = h('div', { class: 'login-body' }, safariHint(), backBtn('返回'), emailTitle,
    h('p', { class: 'login-sub' }, withTail(T.emailSub, T.emailSubTail), extras.tgHint ? [h('br'), T.tgEmailHint] : null), emailForm);
  const emailStep = h('section', { class: 'login-step', 'data-step': 'email', 'aria-labelledby': 'login-title-email' }, emailBody);

  // ---------- 3. 验证码 ----------
  const cells = Array.from({ length: 6 }, () => h('div', { class: 'login-cell' }));
  const codeInput = h('input', {
    class: 'login-code-input', id: 'login-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    pattern: '[0-9]*', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
    'aria-describedby': 'login-code-desc login-code-auto',
  });
  const codeDesc = h('p', { class: 'login-sub', id: 'login-code-desc' });
  const resendText = h('span', { class: 'login-resend-text' });
  // 重发后这个按钮会被藏起来：焦点移回验证码框，不要掉到页首
  const resendBtn = h('button', {
    type: 'button', class: 'login-link pressable', hidden: true,
    on: { click: () => flow.resend().then(() => { if (!destroyed && flow.state.step === 'code') codeInput.focus({ preventScroll: true }); }) },
  }, T.resendButton);
  const codeStatus = statusRows();
  const enterBtn = primary(T.codeButton, { type: 'submit' });
  const codeTitle = h('h1', { class: 'login-title', id: 'login-title-code', tabindex: '-1' }, T.codeTitle);
  const codeForm = h('form', { class: 'login-form', novalidate: true },
    h('label', { class: 'sr-only', for: 'login-code' }, T.codeLabel),
    h('div', { class: 'login-code' }, h('div', { class: 'login-cells', 'aria-hidden': 'true' }, cells), codeInput),
    h('span', { class: 'sr-only', id: 'login-code-auto' }, T.codeAuto),
    h('p', { class: 'login-resend' }, resendText, resendBtn),
    codeStatus.notice, codeStatus.error, enterBtn);
  codeInput.addEventListener('input', () => { flow.inputCode(codeInput.value).catch((e) => console.error(e)); });
  // 游标固定在最后（6 格只显示，不支援从中间插入）
  const caretToEnd = () => { const n = codeInput.value.length; try { codeInput.setSelectionRange(n, n); } catch { /* 部分类型不支援 */ } };
  codeInput.addEventListener('focus', caretToEnd);
  codeInput.addEventListener('click', caretToEnd);
  codeForm.addEventListener('submit', (e) => { e.preventDefault(); flow.submitCode().catch((err) => console.error(err)); });
  const codeBody = h('div', { class: 'login-body' }, safariHint(), backBtn('返回，换一个邮箱'), codeTitle, codeDesc, codeForm);
  const codeStep = h('section', { class: 'login-step', 'data-step': 'code', 'aria-labelledby': 'login-title-code' }, codeBody);

  // ---------- 4. 确认连接 Telegram（只有 Telegram 模式会走到） ----------
  const linkLead = h('p', { class: 'login-sub login-link-lead' });
  const linkStatus = statusRows();
  const linkBtn = primary(T.linkButton, { type: 'button', on: { click: () => flow.confirmLink().catch((e) => console.error(e)) } });
  const linkCancelBtn = h('button', { type: 'button', class: 'login-secondary pressable', on: { click: () => flow.cancelLink() } }, T.linkCancel);
  const linkTitle = h('h1', { class: 'login-title', id: 'login-title-link', tabindex: '-1' }, T.linkTitle);
  const linkBody = h('div', { class: 'login-body' }, linkTitle, linkLead,
    h('p', { class: 'login-field-hint login-link-note' }, T.linkNote),
    linkStatus.notice, linkStatus.error, linkBtn, linkCancelBtn);
  const linkStep = h('section', { class: 'login-step', 'data-step': 'link', 'aria-labelledby': 'login-title-link' }, linkBody);
  let linkLeadKey = null;

  const steps = { welcome, email: emailStep, code: codeStep, link: linkStep };
  const el = h('div', { class: 'login' }, welcome, emailStep, codeStep, linkStep);
  for (const node of Object.values(steps)) node.hidden = true; // start() 读完前三步都不显示（避免欢迎页一闪）
  root.replaceChildren(el);

  // 有对话框（换账号确认）时，登录页不可操作、VoiceOver 也不会读到后面
  cleanups.push(onDepthChange((d) => { el.inert = d > 0; }));

  // ---------- 文字区 ----------
  // 错误：同一句再出现（序号变了）先清空再写，role=alert 才会再念
  const sayError = makeErrorWriter({ alive: () => !destroyed });

  // ---------- 倒数 ----------
  function updateResend() {
    const left = flow.resendLeft();
    resendText.textContent = left > 0 ? T.resendIn(left) : '';
    resendText.hidden = left === 0;
    resendBtn.hidden = left > 0;
    if (left === 0 && timer) { clearInterval(timer); timer = null; }
  }
  function startTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    updateResend();
    if (flow.resendLeft() > 0) timer = setInterval(updateResend, 1000);
  }

  // ---------- 键盘：整块往上移（只用 transform） ----------
  function activeBody() {
    const st = flow.state.step;
    return st === 'email' ? emailBody : st === 'code' || st === 'done' ? codeBody : null;
  }
  // 实际的位移（过渡动画中途也对），不用目标值
  function actualLift(body) {
    const tf = getComputedStyle(body).transform;
    if (!tf || tf === 'none') return 0;
    try { return -new DOMMatrixReadOnly(tf).m42; } catch { return 0; }
  }
  function updateLift() {
    const vv = window.visualViewport;
    const body = activeBody();
    if (!vv || !body) return;
    const form = body.querySelector('.login-form');
    const first = body.firstElementChild;        // Safari 提示或返回键：表单最多移到它原本的位置
    const cur = actualLift(body);
    const r = form.getBoundingClientRect();
    const focused = body.contains(document.activeElement) && document.activeElement.matches('input')
      ? document.activeElement.getBoundingClientRect().top : null;
    let next = keyboardLift({
      blockTop: r.top, blockBottom: r.bottom, currentLift: cur,
      vvHeight: vv.height, vvOffsetTop: vv.offsetTop,
      minTop: first.getBoundingClientRect().top + cur, focusTop: focused,
    });
    const rounded = Math.round(next); // 取整＋容差：避免 1/64px 的差异来回触发过渡
    if (Math.abs(rounded - lift) >= 1) {
      lift = rounded;
      next = rounded;
      body.style.transform = next ? `translateY(${-next}px)` : '';
    }
  }
  let liftQueued = false;
  const queueLift = () => {
    if (liftQueued || destroyed) return;
    liftQueued = true;
    requestAnimationFrame(() => { liftQueued = false; if (!destroyed) updateLift(); });
  };
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueLift);
    window.visualViewport.addEventListener('scroll', queueLift);
    cleanups.push(() => {
      window.visualViewport.removeEventListener('resize', queueLift);
      window.visualViewport.removeEventListener('scroll', queueLift);
    });
  }
  el.addEventListener('focusin', queueLift);
  // 位移过渡结束再量一次（过渡中途量到的若不准，这里补正）
  for (const b of [emailBody, codeBody]) b.addEventListener('transitionend', queueLift);

  // 回到前景：倒数用 sentAt 重算（iOS 背景会停计时器）、检查验证码是否过期
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    flow.checkExpiry();
    if (flow.state.step === 'code') startTimer();
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));

  // ---------- 画面 ----------
  let prevBusy = false;
  let prevErrorSeq = 0;
  let prevNoticeSeq = 0;
  let sentText = null;
  function render(s) {
    if (destroyed || !s.ready) return;
    const step = s.step === 'done' ? (prevStep === 'link' ? 'link' : 'code') : s.step;
    const changed = step !== prevStep;

    // 邮箱页：回来时预先填好
    if (step === 'email' && changed && !emailInput.value && s.email) emailInput.value = s.email;
    // 验证码页
    const sent = T.sentTo(s.email);
    if (sent !== sentText) { sentText = sent; codeDesc.replaceChildren(...withTail(sent, T.sentToTail)); }
    if (codeInput.value.replace(/\D/g, '').slice(0, 6) !== s.code) codeInput.value = s.code;
    // 连接页：名字、邮箱一律当文字
    const leadKey = `${s.linkLabel}\n${s.linkEmail}`;
    if (leadKey !== linkLeadKey) {
      linkLeadKey = leadKey;
      linkLead.replaceChildren(...linkLeadParts(s.linkLabel, s.linkEmail).map((p) => (p.strong ? h('strong', null, p.text) : p.text)));
    }
    codeCells(s.code).forEach((c, i) => {
      cells[i].textContent = c.v;
      cells[i].classList.toggle('is-active', c.active && !s.busy);
    });

    if (changed) {
      // 先显示新步骤、移焦点，再藏旧步骤（有焦点的输入框先被藏起来，iOS 会收键盘）
      const next = steps[step];
      next.hidden = false;
      for (const b of [emailBody, codeBody, linkBody]) b.style.transform = '';
      lift = 0;
      if (prevStep && !reducedMotion()) fade(next, 'in', { id: 'login' });
      if (step === 'code') {
        startTimer();
        codeInput.focus({ preventScroll: true });
      } else {
        if (timer) { clearInterval(timer); timer = null; }
        if (step === 'email' && prevStep === 'welcome') emailInput.focus({ preventScroll: true });
        else if (prevStep) ({ welcome: welcomeTitle, email: emailTitle, link: linkTitle })[step].focus({ preventScroll: true });
      }
      for (const [k, node] of Object.entries(steps)) if (k !== step) node.hidden = true;
    } else if (step === 'code') {
      updateResend();
      if (flow.resendLeft() > 0 && !timer) startTimer();
    }

    // 讯息
    const status = step === 'code' ? codeStatus : step === 'link' ? linkStatus : emailStatus;
    for (const other of [codeStatus, emailStatus, linkStatus]) {
      if (other === status) continue;
      other.notice.textContent = '';
      other.error.textContent = '';
    }
    status.notice.textContent = s.notice || '';
    // 提示（过期、已重新发送…）：步骤切换同时出现的字 VoiceOver 常不念，改走 announce
    if (s.notice && s.noticeSeq !== prevNoticeSeq) announce(s.notice);
    const freshError = s.errorSeq !== prevErrorSeq;
    sayError(status.error, s.error || '', freshError || changed);

    // 送出中：按钮文字只跟自己的动作
    sendBtn.textContent = s.busy === 'send' ? T.sending : T.sendButton;
    enterBtn.textContent = s.busy === 'verify' ? T.signingIn : T.codeButton;
    linkBtn.textContent = s.busy === 'link' ? T.linking : T.linkButton;
    for (const b of [sendBtn, enterBtn, resendBtn, linkBtn, linkCancelBtn]) b.setAttribute('aria-disabled', s.busy ? 'true' : 'false');
    if (s.busy === 'verify' && prevBusy !== 'verify') announce('正在登录');
    if (s.busy === 'link' && prevBusy !== 'link') announce('正在连接');

    // 栏位标示错误（aria-invalid 要是字串 "true"，空值等于没错）
    for (const [field, input] of [['email', emailInput], ['invite', inviteInput]]) {
      if (s.error && s.errorField === field) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
    if (s.error && freshError && step === 'email') {
      if (s.errorField === 'invite') inviteInput.focus({ preventScroll: true });
      else if (s.errorField === 'email') emailInput.focus({ preventScroll: true });
    }

    prevBusy = s.busy;
    prevErrorSeq = s.errorSeq;
    prevNoticeSeq = s.noticeSeq;
    prevStep = step;
    queueLift(); // 讯息出现让表单变高时也要重算
  }

  cleanups.push(flow.subscribe(render));
  flow.start().catch((e) => console.warn('[login] start 失败', e && e.name));

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (timer) clearInterval(timer);
    for (const fn of cleanups) { try { fn(); } catch { /* 已移除 */ } }
    el.remove();
  }
  return { destroy, flow };
}
