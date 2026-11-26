// 全屏阻挡画面（开库失败、Telegram 启动时的「需要网络」「无法确认 Telegram 身份」等）。
import { h } from './dom.js';

/** 标题、说明、一个按钮。文字一律当文字（h() 用 text node）。 */
export function renderFatal(root, { title, message, buttonLabel, onClick }) {
  root.replaceChildren(h('div', { class: 'fatal', role: 'alert' },
    h('h1', { class: 'fatal-title' }, title),
    h('p', { class: 'fatal-message' }, message),
    h('button', { type: 'button', class: 'fatal-button pressable', on: { click: onClick } }, buttonLabel)));
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
  root.replaceChildren(h('div', { class: 'fatal', role: 'status' }, h('p', { class: 'fatal-message' }, text)));
}
