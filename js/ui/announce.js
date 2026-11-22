// 读屏朗读：一个常驻、视觉隐藏的 polite status 区（直接挂在 body 下，不在会被设为 inert 的 shell 里）。
// 启动时就建立：iOS VoiceOver 对「刚插入就有文字」的 live region 常常不念。
// 每次先清空、稍后才放文字：同一句连说两次时内容有变动，才会再念；也让它排在关面板后的焦点朗读之后。
// 念完 CLEAR 毫秒后清空：读屏滑到页尾才不会摸到残留的旧句子（太快会打断朗读）。
const DELAY = 100;
const CLEAR = 5000;

export function createAnnouncer(doc, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  const region = doc.createElement('div');
  region.className = 'sr-only live-region';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  doc.body.append(region);
  let timer = 0;
  return {
    region,
    say(text) {
      if (!region.isConnected) doc.body.append(region);
      cancel(timer);
      region.textContent = '';
      timer = schedule(() => {
        region.textContent = text;
        timer = schedule(() => { region.textContent = ''; }, CLEAR);
      }, DELAY);
    },
  };
}

let shared = null;
/** app 启动时呼叫一次。 */
export function initAnnouncer() {
  if (!shared && typeof document !== 'undefined') shared = createAnnouncer(document);
}
export function announce(text) {
  initAnnouncer();
  if (shared) shared.say(text);
}
