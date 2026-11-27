// 3f：设置里的两个说明页（隐私说明、在 Telegram 记账）。文案用户 2026-11-28 定稿：口语、简短；
// 不提 Claude／Anthropic（只说「AI 服务商」）、不用「站主」（说「管理的人」）。改字要先问用户。
// 骨架照 keywords-page：nav-page 推入、返回键、Esc／返回手势关闭、焦点留在页内、关掉后焦点回到打开它的那一列。
import { h } from './dom.js';
import { icon } from './icons.js';
import { pushLayer } from './nav.js';
import { trapFocus } from './dialogs.js';

export const INFO_PAGES = Object.freeze({
  privacy: Object.freeze({
    title: '隐私说明',
    paras: Object.freeze([
      '账先存在手机里，登录后会同步，换手机或在 Telegram 打开都是同一本账。',
      '管理的人在后台看得到你的账和邮箱。',
      '用 bot 记账时，截图和文字会交给 AI 服务商认金额和分类，一般最多留 30 天，我们不存截图。App 里手动记的不会。',
      '不想用了，在设置最下面删账号，服务器上的账会全部删掉。删之前可以先导出 CSV。',
      '有问题直接问邀请你的人。',
    ]),
  }),
  telegram: Object.freeze({
    title: '在 Telegram 记账',
    lead: '在 Telegram 传付款截图，或打「午餐 12.50」，就会记一笔，跟这里是同一本账。',
    steps: Object.freeze([
      '打开 @adjizhangbot，按「开始」。',
      '按左下角「记账」，用同一个邮箱登录。',
      '问你要不要连接时，按「连接」。',
    ]),
    notes: Object.freeze([
      '在 Telegram 登录要 10 分钟内弄完，先把收信的 App 开着比较快。',
      '画面出错就关掉再开一次。',
    ]),
    action: Object.freeze({ label: '打开 @adjizhangbot', href: 'https://t.me/adjizhangbot' }),
  }),
});

let seq = 0;

/** 推入说明页。kind：'privacy' | 'telegram'。回 { close }。 */
export function openInfoPage(kind, { from = '设置' } = {}) {
  const page = INFO_PAGES[kind];
  const opener = document.activeElement;
  const uid = `info-${++seq}`;

  const backBtn = h('button', { type: 'button', class: 'nav-back', on: { click: () => close() } },
    h('span', { class: 'nav-back-chevron', 'aria-hidden': 'true' }, icon('chevron-left', 22)),
    h('span', null, from));
  const bar = h('header', { class: 'nav-page-bar' },
    backBtn,
    h('h2', { class: 'nav-page-title', id: `${uid}-title` }, page.title),
    h('span', { 'aria-hidden': 'true' }));

  const content = page.paras
    ? [h('div', { class: 'info-card' }, page.paras.map((t) => h('p', { class: 'info-para' }, t)))]
    : [
      h('div', { class: 'info-card' },
        h('p', { class: 'info-para' }, page.lead),
        h('ol', { class: 'info-steps' }, page.steps.map((t) => h('li', null, t)))),
      h('a', { class: 'info-action', href: page.action.href, target: '_blank', rel: 'noopener' }, page.action.label),
      ...page.notes.map((t) => h('p', { class: 'settings-footer info-note' }, t)),
    ];
  const body = h('div', { class: 'nav-page-body' }, content);
  const el = h('div', {
    class: 'nav-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title`,
  }, bar, body);
  trapFocus(el, el);

  let closed = false;
  const handle = pushLayer({
    element: el,
    onClose: () => {
      closed = true;
      el.classList.remove('is-visible');
      const remove = () => el.remove();
      el.addEventListener('transitionend', (e) => { if (e.target === el) remove(); });
      setTimeout(remove, 450); // 后备
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    },
  });
  function close() { handle.close(); }

  document.body.append(el);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) el.classList.add('is-visible'); }));
  return { close };
}
