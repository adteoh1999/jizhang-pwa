// 全屏阻挡画面（开库失败、Telegram 启动时的「需要网络」「无法确认 Telegram 身份」等）。
import { h } from './dom.js';
import { announce } from './announce.js';

/** 标题、说明、一个按钮（没给 buttonLabel 就不放）。文字一律当文字（h() 用 text node）。焦点移到标题（整个画面被换掉时读屏从这里念）。 */
export function renderFatal(root, { title, message, buttonLabel, onClick }) {
  const t = h('h1', { class: 'fatal-title', tabindex: '-1' }, title);
  root.replaceChildren(h('div', { class: 'fatal', role: 'alert' },
    t,
    h('p', { class: 'fatal-message' }, message),
    buttonLabel ? h('button', { type: 'button', class: 'fatal-button pressable', on: { click: onClick } }, buttonLabel) : null));
  try { t.focus({ preventScroll: true }); } catch { /* 忽略 */ }
}

/** 开库失败的全屏画面。 */
export function renderDbError(root, err) {
  renderFatal(root, {
    title: '无法开启资料库',
    message: (err && err.message) || String(err || '未知错误'),
    buttonLabel: '重新整理',
    onClick: () => location.reload(),
  });
}

/** 「正在载入…」（Telegram 启动等服务器超过 1 秒时）。没有按钮。 */
export function renderLoading(root, text) {
  root.replaceChildren(h('div', { class: 'fatal' }, h('p', { class: 'fatal-message' }, text)));
  try { announce(text); } catch { /* 读屏区还没准备好：不影响画面 */ }
}
