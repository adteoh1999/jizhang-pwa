// 「添加到主屏幕」提示：只在 iOS Safari、尚未加到主屏幕时显示；关掉后记在 store meta。
import { h } from './dom.js';
import { icon } from './icons.js';

const META_KEY = 'installHintDismissed';

export function isIosBrowserTab() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua);
  const standalone = navigator.standalone === true
    || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
  return ios && !standalone;
}

/** root：放提示的容器（插在最前面）；store：用来读写 installHintDismissed。 */
export async function maybeShowInstallHint(root, store) {
  if (!isIosBrowserTab()) return null;
  let dismissed = false;
  try { dismissed = (await store.getMeta(META_KEY)) === true; } catch (e) { console.error(e); }
  if (dismissed) return null;

  const close = h('button', {
    type: 'button', class: 'install-hint-close pressable', 'aria-label': '关闭提示',
    on: {
      click: () => {
        el.remove();
        store.setMeta(META_KEY, true).catch((e) => console.error(e));
      },
    },
  }, h('span', { 'aria-hidden': 'true' }, '✕'));
  const el = h('div', { class: 'install-hint', role: 'note', 'data-install-hint': '' },
    h('span', { class: 'install-hint-icon' }, icon('square-arrow-up', 20)),
    h('p', { class: 'install-hint-text' }, '添加到主屏幕使用：点 分享 → 添加到主屏幕'),
    close);
  root.prepend(el);
  return el;
}
