// v2.3 动画共用工具：弹簧曲线、时长、减弱动态判断、WAAPI 包装、数字滚轮、FLIP。
// 规则：只动 transform / opacity；不用模糊、不提示浏览器预先建图层；动画结束不留 fill: forwards（退场后马上移除的除外）。
// 纯函数（springLinear / slideX / digitPlan / shouldAnimateCard）可在 Node 测试；其余只在浏览器呼叫。

/** 阻尼弹簧 → CSS linear() 字串；p = 弹过头的比例（0.08 = 8%），时长结束时停稳。 */
export function springLinear(p) {
  const lp = Math.log(p);
  const z = -lp / Math.sqrt(Math.PI * Math.PI + lp * lp);   // 阻尼比
  const w = 5.5 / z;                                          // e^(-5.5) ≈ 0.004 → 结束时停稳
  const wd = w * Math.sqrt(1 - z * z);
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    let x = 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t));
    if (i === 40) x = 1;
    pts.push(+x.toFixed(4));
  }
  return `linear(${pts.join(', ')})`;
}

export const SPRING = springLinear(0.04);          // v2.3.1：弹性减半（v2.3 是 8%）
export const SPRING_FALLBACK = 'cubic-bezier(0.34, 1.35, 0.64, 1)'; // 不支援 linear()（iOS < 17.2）
export const EASE_OUT = 'cubic-bezier(0.32, 0.72, 0, 1)';            // 同 CSS --ease-out：退场用
export const EASE_DRAW = 'cubic-bezier(0.3, 0, 0.2, 1)';             // 走势线画出

// v2.3.1：用户实测嫌慢 → 大部分 0.15–0.25 秒，飘字 0.8 秒
export const DUR = {
  roll: 250, bar: 250, rowMove: 220, rowIn: 200, rowOut: 180, pop: 180,
  tab: 200, draw: 250, dot: 180, monthOut: 100, monthIn: 200,
  fade: 200, float: 800, barStagger: 20, barDelay: 40, digitStagger: 12,
};

/** 支不支援 overflow-x: clip（iOS 16 起）；不支援时横向滑动会短暂出现横向滚动，只用淡入淡出。 */
let clipOK = null;
export function clipSupported() {
  if (clipOK === null) clipOK = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('overflow-x', 'clip');
  return clipOK;
}

export function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 曲线选择（纯函数）：支援 linear() 就用原曲线；不支援时弹簧 → 后备。 */
export function pickEasing(easing, linearSupported) {
  if (linearSupported || !easing.startsWith('linear(')) return easing;
  return SPRING_FALLBACK;
}

// 与 CSS 的 @supports 用同一个判断来源
let linearOK = null;
function linearSupported() {
  if (linearOK === null) {
    linearOK = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('transition-timing-function', 'linear(0, 1)');
  }
  return linearOK;
}

/** element.animate 的包装：不支援时回传 null；预设弹簧、fill backwards（延迟期间就停在起点）。id：用来只取消自己的动画。 */
export function animate(el, keyframes, { duration, easing = SPRING, delay = 0, fill = 'backwards', id = '' } = {}) {
  if (!el || typeof el.animate !== 'function') return null;
  try {
    const a = el.animate(keyframes, { duration, easing: pickEasing(easing, linearSupported()), delay, fill });
    if (id) a.id = id;
    return a;
  } catch (e) {
    console.error(e);   // 动画只是装饰：出错就不播，功能照常
    return null;
  }
}

/** 取消元素上的动画（只取消 id 相符的；不给 id 就全部）。不支援 getAnimations 时不做事。 */
export function cancelAnims(el, { id = '', subtree = false } = {}) {
  if (!el || typeof el.getAnimations !== 'function') return;
  for (const a of el.getAnimations({ subtree })) if (!id || a.id === id) a.cancel();
}

/** 淡入 / 淡出（减弱动态时的替代）。淡出会停在 0（呼叫者负责之后移除或 cancel）。 */
export function fade(el, dir, { duration = DUR.fade, delay = 0, id = '' } = {}) {
  const kf = dir === 'in' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
  return animate(el, kf, { duration, delay, id, easing: 'ease', fill: dir === 'in' ? 'backwards' : 'forwards' });
}

/** 比例条「滑入」做法：填充条固定 100% 宽，往左藏 (1 − ratio)。minPx：有值时最少露出的宽度。 */
export function slideX(ratio, minPx = 0) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  if (r <= 0) return 'translateX(-100%)';
  if (minPx > 0) return `translateX(calc(max(${minPx}px, ${(r * 100).toFixed(2)}%) - 100%))`;
  return `translateX(${((r - 1) * 100).toFixed(2)}%)`;
}

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * 滚轮规划：新字串逐字元；数字位由右对齐，from = 旧字串同一位（旧的位数较少 → 0）。
 * 旧字串没有任何数字（首次、••••）→ from = to（不滚）。rank = 由右数第几位（0 起）。
 */
export function digitPlan(oldStr, newStr) {
  const oldD = [...oldStr].filter(isDigit).reverse();
  let left = [...newStr].filter(isDigit).length;
  return [...newStr].map((ch) => {
    if (!isDigit(ch)) return { ch, digit: false, from: -1, to: -1, rank: -1 };
    left -= 1;
    const to = +ch;
    const from = oldD.length === 0 ? to : (oldD[left] !== undefined ? +oldD[left] : 0);
    return { ch, digit: true, from, to, rank: left };
  });
}

/** 结余卡要不要动画：只有资料变动、不是第一次、没有隐藏金额。 */
export function shouldAnimateCard({ first, hidden, reason }) {
  return !first && !hidden && reason === 'data';
}

// 「用户刚新增的一笔」：记一笔储存后标记，首页画出这一列时取走（决定要不要飘字）
const justAdded = new Set();
export function markJustAdded(id) { justAdded.add(id); }
export function takeJustAdded(id) { return justAdded.delete(id); }

// ---------- 数字滚轮 ----------
const rolled = new WeakMap(); // 元素 → 目前（目标）字串
const COL_DIGITS = '0123456789';

/** 把滚轮规划合成显示用的段：连续的非数字字元合成一段（「RM 」「••••」），每个数字各自一段。 */
export function rollRuns(plan) {
  const out = [];
  for (const p of plan) {
    if (p.digit) out.push(p);
    else if (out.length && !out[out.length - 1].digit) out[out.length - 1].text += p.ch;
    else out.push({ digit: false, text: p.ch });
  }
  return out;
}

/**
 * 把 el 的内容设成 str；animate 时只有变的位数从旧数字滚到新数字。
 * 容器要已经 aria-hidden（读屏读 .sr-only）。动画中又呼叫：旧节点整批换掉（旧动画随之消失），
 * 从上一次的「目标值」接着滚（不是画面上滚到一半的位置；只有滚动期间（约 0.3 秒）内连续变动才看得出差别）。
 */
export function rollTo(el, str, { animate: anim = false } = {}) {
  const old = rolled.get(el) ?? '';
  if (old === str && el.childElementCount) return;
  cancelAnims(el, { id: 'roll-fade' });
  rolled.set(el, str);
  el.classList.add('roll');
  const doc = el.ownerDocument;
  const moving = [];
  const nodes = rollRuns(digitPlan(old, str)).map((r) => {
    if (!r.digit) {
      const s = doc.createElement('span');
      s.textContent = r.text;
      return s;
    }
    const col = doc.createElement('span');
    col.className = 'roll-col';
    for (const d of COL_DIGITS) {
      const s = doc.createElement('span');
      s.textContent = d;
      col.append(s);
    }
    col.style.transform = `translateY(${-r.to * 10}%)`;
    if (r.from !== r.to) moving.push([col, r]);
    const reel = doc.createElement('span');
    reel.className = 'reel';
    reel.append(col);
    return reel;
  });
  el.replaceChildren(...nodes);
  if (!anim || !old) return;
  if (reducedMotion()) {
    const a = fade(el, 'in');
    if (a) a.id = 'roll-fade';
    return;
  }
  for (const [col, r] of moving) {
    animate(col, [{ transform: `translateY(${-r.from * 10}%)` }, { transform: `translateY(${-r.to * 10}%)` }],
      { duration: DUR.roll, delay: r.rank * DUR.digitStagger, easing: EASE_OUT });
  }
}

// ---------- FLIP ----------
/** 量 root 里每个 [data-flip] 元素目前（含进行中的位移）在画面上的 top。 */
export function snapshotTops(root) {
  const m = new Map();
  for (const el of root.querySelectorAll('[data-flip]')) m.set(el.dataset.flip, el.getBoundingClientRect().top);
  return m;
}

/**
 * 重画后呼叫：留下来的元素从旧位置 translateY 动画回原位；新出现且 isEnter(key) 的元素从上方淡入滑入。
 * 两段式：先取消上一次的 FLIP 动画（只取消 id='flip'，不碰删除滑出等别人的动画），全部量完再全部写。
 * 巢状（日期区块里的列）：子元素只做「相对父元素」的位移；父元素在进场时子元素不另外动画。
 * 只动画面里看得到的元素。减弱动态：不位移，新元素淡入。
 */
export function playFlip(root, before, { isEnter = () => false, skip = () => false } = {}) {
  cancelAnims(root, { id: 'flip', subtree: true });   // 一次取完再取消，不和量位置交错
  const els = [...root.querySelectorAll('[data-flip]')];
  const index = new Map(els.map((el, i) => [el, i]));
  const items = els.map((el) => {
    const anc = el.parentElement && el.parentElement.closest('[data-flip]');
    return {
      key: el.dataset.flip,
      top: el.getBoundingClientRect().top,   // 只排版一次
      parent: anc && index.has(anc) ? index.get(anc) : -1,
      skip: skip(el),
    };
  });
  const rm = reducedMotion();
  for (const [i, p] of flipPlan(items, before, { vh: window.innerHeight, isEnter })) {
    const el = els[i];
    if (p.enter) {
      if (rm) fade(el, 'in', { id: 'flip' });
      else animate(el, [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: DUR.rowIn, delay: 40, id: 'flip' });
    } else if (!rm && Math.abs(p.dy) >= 0.5) {
      animate(el, [{ transform: `translateY(${p.dy}px)` }, { transform: 'none' }], { duration: DUR.rowMove, id: 'flip' });
    }
  }
}

/**
 * FLIP 规划（纯函数）。items 依文件顺序：{ key, top（之后的位置）, parent（最近的 flip 祖先索引，没有 = -1）, skip }。
 * 回传 Map(索引 → { dy }（相对父元素的位移）或 { enter: true, dy: 0 })。
 * 父元素进场时子元素不另外动；画面外（top < -80 或 > vh）与 skip（例如正在滑出）的不动。
 */
export function flipPlan(items, before, { vh, isEnter }) {
  const plan = new Map();
  items.forEach((it, i) => {
    const a = it.parent >= 0 ? plan.get(it.parent) : null;
    if (a && a.enter) return;
    if (it.skip || it.top < -80 || it.top > vh) return;
    if (before.has(it.key)) plan.set(i, { dy: before.get(it.key) - it.top - (a ? a.dy : 0) });
    else if (isEnter(it.key)) plan.set(i, { enter: true, dy: 0 });
  });
  return plan;
}
