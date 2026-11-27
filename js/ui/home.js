// 首页：本月结余卡（晨雾玻璃 + 眼睛隐藏金额 + 比例线）、黑色「记一笔」、账单抽屉（按日期分组，左滑删除 + 撤销）。
// 注意：entry-sheet.js 必须静态导入，openEntrySheet 必须在点击事件里同步呼叫（不能先 await），
// iOS 才会在金额框 focus() 时弹出键盘。
//
// 无障碍删除路径：每一列的红色「删除」按钮一直在 DOM 里（排在列内容之后），
// 键盘 Tab / VoiceOver 都能直接到达并启动，不必左滑；键盘焦点落在它上面时，该列自动滑开露出按钮。
import { h } from './dom.js';
import { icon, rowIconAttr } from './icons.js';
import { openEntrySheet } from './entry-sheet.js';
import { haptic } from '../tg-chrome.js';
import { openCategoriesPage } from './categories-page.js';
import { showToast } from './toast.js';
import { messageDialog } from './dialogs.js';
import { depth, whenIdle, onDepthChange, isIdle } from './nav.js';
import {
  rollTo, slideX, animate, fade, cancelAnims, reducedMotion, shouldAnimateCard, takeFloats, takeSavedForList, DUR,
  EASE_OUT, snapshotTops, playFlip, playEnter,
} from './motion.js';
import { summarizeMonth, groupByDate, spendMeter } from '../stats.js';
import { formatRM } from '../money.js';
import { todayLocal, monthOf, formatDayHeader, formatMonthTitle } from '../dates.js';

const PAGE = 200;            // 一次显示的笔数
const ACTION_W = 80;         // 「删除」按钮宽度
const OPEN_MIN = 40;         // 放开时滑超过这个距离 → 停在打开
const FULL_RATIO = 0.6;      // 滑过列宽 60% → 直接删除
const LOCK_DIST = 10;        // 判断方向前要移动的距离
const LOST_GRACE = 150;      // 失去 pointer capture 后等多久才当作手势中断（ms）

/** 结余数字拆成整数与「.角」；负数在整数前加 U+2212（「RM」另外显示）。 */
export function balanceParts(minor) {
  const [i, f] = formatRM(minor, { sign: 'none' }).slice(3).split('.');
  return { sign: minor < 0 ? '\u2212' : '', int: i, dec: `.${f}` };
}

/** 依整数部分字元数（含 U+2212 与逗号，不含「RM」）决定大数字缩级：≤5 → ''，6–9 → is-long，≥10 → is-xlong。 */
export function balanceSizeClass(minor) {
  const { sign, int } = balanceParts(minor);
  const n = sign.length + int.length;
  return n >= 10 ? 'is-xlong' : n >= 6 ? 'is-long' : '';
}

/** 卡片里收入 / 支出金额：字串 ≥13 字元（RM 999,999.99 起）缩一级字。 */
export function flowSizeClass(minor) {
  return formatRM(minor, { sign: 'none' }).length >= 13 ? 'is-small' : '';
}

// ---------- 眼睛：隐藏金额 ----------
// 状态只存在这台装置（localStorage），不上传；读写失败（私密模式、被停用）一律当作「显示」。
export const HIDE_KEY = 'jizhang.hideAmounts';
export const MASK = '\u2022\u2022\u2022\u2022'; // ••••

/** 读隐藏状态。storage 由呼叫端传入（Node 测试不碰 localStorage）。 */
export function readHidden(storage) {
  try { return storage?.getItem(HIDE_KEY) === '1'; } catch { return false; }
}

/** 存隐藏状态：隐藏 → '1'；显示 → 删掉这个键。 */
export function writeHidden(storage, hidden) {
  try {
    if (hidden) storage?.setItem(HIDE_KEY, '1');
    else storage?.removeItem(HIDE_KEY);
  } catch { /* 存不了就只在这次开启时有效 */ }
}

/** 拿到 localStorage；取用本身就可能 throw（Safari 停用网站资料时）。 */
function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * 结余卡要显示的内容（纯函数）。
 * 隐藏时：数字都换成 ••••，负号、缩级 class 也拿掉（不能从大小或正负看出金额），读屏读「已隐藏」。
 * 比例线也藏：线宽 0、文字一律「已花掉收入的 ••%」（「支出已超过收入」「还没有收入」本身就会透露结余正负）。
 * meter：barHidden 线条是否隐藏、pct 线宽、label 线条读屏文字、note 线下文字、noteRead 文字是否给读屏读、
 *   noteShown 文字是否显示在卡片上（B 改版：只有超支时显示「支出已超过收入」，用户 2026-11-27）。
 */
export function cardView(s, hidden) {
  if (hidden) {
    const flow = { text: `RM ${MASK}`, sr: '已隐藏', cls: '' };
    return {
      sign: '', int: MASK, dec: '', sizeCls: '', balSr: '已隐藏', income: flow, expense: { ...flow },
      meter: { barHidden: false, pct: 0, label: '花费比例已隐藏', note: '已花掉收入的 \u2022\u2022%', noteRead: false, noteShown: false },
    };
  }
  const m = spendMeter(s.income, s.expense);
  const text = meterText(m);
  const bp = balanceParts(s.balance);
  const flow = (v) => {
    const text = formatRM(v, { sign: 'none' });
    return { text, sr: text, cls: flowSizeClass(v) };
  };
  return {
    sign: bp.sign, int: bp.int, dec: bp.dec, sizeCls: balanceSizeClass(s.balance),
    balSr: formatRM(s.balance), income: flow(s.income), expense: flow(s.expense),
    // 线条显示时由它（role=img）读出，文字不重复读；线条隐藏（没有收入）时由文字读出
    meter: { barHidden: m.state === 'none', pct: m.pct, label: text, note: text, noteRead: m.state === 'none', noteShown: m.state === 'over' },
  };
}

/** 记账后卡片上飘出的字：收入「+RM x」、支出「−RM x」（U+2212）。 */
export function floatText(tx) {
  return tx.kind === 'income'
    ? formatRM(tx.amount_minor, { sign: 'always' })
    : formatRM(-tx.amount_minor);
}

/** 列表重画后，新出现的列要不要从上方滑入：只有资料变动（不是首次、显示更多、从背景回来）。 */
export function flipEnterable(reason, first) {
  return !first && reason === 'data';
}

/** 重画原因合并：'data'（资料变动，会动画）优先，其余保留先来的。 */
export function mergeReason(pending, reason) {
  return pending === 'data' || reason === 'data' ? 'data' : (pending || reason);
}

/**
 * 本机刚存后列表的进场目标（v2.3.1：储存不补位，只让新的那笔进场）。
 * added：[{ rowKey, dayKey }]；dayKey 是这次新出现的日期区块 → 动区块（同一个只动一次），否则动那一列。
 */
export function enterTargets(added, newDays) {
  const out = [];
  for (const { rowKey, dayKey } of added) {
    const key = newDays.has(dayKey) ? dayKey : rowKey;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 把 current（key 顺序）变成 next 的操作（纯函数）。
 * remove：current 有、next 没有；moves：依 next 顺序，位置上不是它时 [key, beforeKey|null]（null = 放最后）。
 * 已在正确位置的不动；顶端或中间插入只动一个（一个 key 往下搬过 N 个邻居会变 N 次，实际几乎遇不到）。
 */
export function reconcile(current, next) {
  const want = new Set(next);
  const remove = current.filter((k) => !want.has(k));
  const cur = current.filter((k) => want.has(k));
  const moves = [];
  next.forEach((key, i) => {
    if (cur[i] === key) return;
    moves.push([key, cur[i] === undefined ? null : cur[i]]);
    const j = cur.indexOf(key, i);
    if (j >= 0) cur.splice(j, 1);
    cur.splice(i, 0, key);
  });
  return { remove, moves };
}

/**
 * 让 container 的子节点变成 next（key = data-flip），只搬需要搬的。elOf(key) → 现在代表这个 key 的节点。
 * 先拿掉「不是 elOf(key) 的旧节点」（没有 key 的空列表提示、删除后撤销留下的透明旧列）。
 */
export function syncChildren(container, next, elOf) {
  for (const el of [...container.children]) if (elOf(el.dataset.flip) !== el) el.remove();
  const live = [...container.children];
  const { remove, moves } = reconcile(live.map((el) => el.dataset.flip), next);
  for (const k of remove) elOf(k).remove();
  for (const [k, before] of moves) container.insertBefore(elOf(k), before === null ? null : elOf(before));
}

/**
 * 「之前」的位置里拿掉已不在 rows 的列（删除后重画被延后、又按撤销时，DOM 里还留着透明旧列）：
 * 不拿掉的话，复原的新列会被当成「没动」而直接出现，不会滑入。日期区块（d…）保留。
 */
export function pruneBefore(before, hasRow) {
  for (const k of [...before.keys()]) if (k.startsWith('t') && !hasRow(k.slice(1))) before.delete(k);
  return before;
}

/** 这次画出、上一次没有的日期区块（判断新区块；不能靠「之前量到的位置」）。 */
export function newDayKeys(days, lastDays) {
  return new Set([...days].filter((d) => !lastDays.has(d)));
}

/** 结余卡要不要先画（v2.3.1）：没有浮层、又有还没画上去的变动 → 卡片马上画，列表照旧等退场播完。 */
export function paintCardEarly({ depth: d, pendingReason }) {
  return d === 0 && pendingReason !== null;
}

/** 有还没画上去的变动（面板正在退场、首页延后重画）时不处理点列：列上还是旧资料。 */
export function rowTapAllowed(pendingReason) {
  return pendingReason === null;
}

/** 眼睛按钮的读屏标签与图示：标签说「按了会怎样」。 */
export function eyeButtonState(hidden) {
  return hidden ? { label: '显示金额', icon: 'eye-off' } : { label: '隐藏金额', icon: 'eye' };
}

/** 比例线文案（输入 spendMeter 的结果）。 */
export function meterText(m) {
  if (m.state === 'none') return '本月还没有收入';
  if (m.state === 'over') return '支出已超过收入';
  return `已花掉收入的 ${m.pct}%`;
}

/** 抽屉标题右侧：全部记录数。 */
export function countText(n) {
  return `共 ${n} 笔`;
}


export function mountHome(root, store, { monthEl = null, storage = defaultStorage() } = {}) {
  let today = todayLocal();
  let shown = PAGE;
  let openRow = null;          // 目前滑开的列 record
  // 这次按下是用来关闭滑开的列 → 接着的 click 不打开 sheet。
  // 用时间窗而非一直留着的旗标：iOS 的 click 可能在 pointerup 之后另一个 task 才到，
  // 但也不能让旗标残留到之后的键盘操作。
  let closingGesture = false;
  let swallowClickUntil = 0;
  const CLICK_WINDOW = 500;
  const rows = new Map();      // id → record { id, tx, el, content, del, sig, offset }
  let order = [];              // 目前画出来的列 id（由上到下）
  let openScrollY = 0;         // 列滑开时的 scrollY；只有真的滚离这个位置才关闭
  // 记一笔里的「＋ 新增」：叠一层分类管理子画面，新增后回到记一笔并选中新分类
  const onAddCategory = ({ kind, select, refocus }) => openCategoriesPage(store, {
    kind, from: 'entry', onPicked: select, restoreFocus: refocus,
  });

  // ---------- 静态骨架 ----------
  // 结余卡：光球是 .home-card-wrap::before（静态渐层，在卡片后面）；卡片本身是半透明玻璃
  // 视觉上拆成三段（aria-hidden），读屏读完整金额（.sr-only）；隐藏金额时读屏读「已隐藏」
  // 隐藏状态在第一次 render 之前就读好，启动时金额不会先闪一下
  let hidden = readHidden(storage);
  let lastSummary = null;
  const balSr = h('span', { class: 'sr-only' });
  const balInt = h('span', { class: 'home-balance-int', 'aria-hidden': 'true' });
  const balDec = h('span', { class: 'home-balance-dec', 'aria-hidden': 'true' });
  const balSign = h('span', { class: 'home-balance-sign', 'aria-hidden': 'true' });
  const balanceEl = h('p', { class: 'home-balance' },
    balSr, balSign, h('span', { class: 'home-balance-cur', 'aria-hidden': 'true' }, 'RM'), balInt, balDec);
  // 收入 / 支出：看得到的字 aria-hidden，读屏读 .sr-only（隐藏时不会读成一串圆点）
  const flowValue = () => {
    const vis = h('span', { 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only' });
    return { el: h('span', { class: 'home-flow-v' }, vis, sr), vis, sr };
  };
  const income = flowValue();
  const expense = flowValue();
  const flowCol = (name, label, valueEl) => h('div', { class: 'home-flow-item' },
    h('span', { class: 'home-flow-k' }, icon(name, 12), label), valueEl);
  const meterFill = h('i', { class: 'home-meter-fill' });
  const meterBar = h('div', { class: 'home-meter-bar', role: 'img' }, meterFill);
  const meterNote = h('span', { class: 'home-meter-note' });
  // 眼睛：切换 aria-label（「隐藏金额 / 显示金额」），不另加 aria-pressed（两个一起读会混乱）
  const eyeBtn = h('button', {
    type: 'button', class: 'home-eye pressable',
    on: { click: () => setHidden(!hidden) },
  });
  const summary = h('section', { class: 'home-card', 'aria-labelledby': 'home-card-label' },
    h('h2', { class: 'home-card-label', id: 'home-card-label' }, '本月结余'),
    eyeBtn,
    balanceEl,
    h('div', { class: 'home-flow' },
      flowCol('arrow-up', '收入', income.el),
      flowCol('arrow-down', '支出', expense.el)),
    h('div', { class: 'home-meter' }, meterBar, meterNote));

  const addBtn = h('button', {
    type: 'button', class: 'home-add pressable',
    on: { click: () => { closeOpenRow(); openEntrySheet(store, { onAddCategory }); haptic('light'); } }, // 同步呼叫；震动放在打开之后（Telegram）
  }, icon('plus', 20), '记一笔');

  const countEl = h('span', { class: 'home-drawer-count' });
  const list = h('div', { class: 'home-list' });
  const moreBtn = h('button', {
    type: 'button', class: 'home-more', hidden: true,
    on: { click: () => { shown += PAGE; requestRender('more'); } },
  }, '显示更多');

  // 账单抽屉：白底上圆角，阴影挂在 .home-drawer::before；最少撑到画面底部（CSS flex）
  const drawer = h('section', { class: 'home-drawer', 'aria-labelledby': 'home-drawer-title' },
    h('div', { class: 'home-drawer-head' },
      h('h2', { class: 'home-drawer-title', id: 'home-drawer-title' }, '账单'), countEl),
    list, moreBtn);

  const cardWrap = h('div', { class: 'home-card-wrap' }, summary);
  root.replaceChildren(cardWrap, addBtn, drawer);

  // ---------- 列 ----------
  function rowSig(tx, cat) {
    return [tx.kind, tx.amount_minor, tx.note, tx.category_id,
      cat ? `${cat.name}|${cat.icon}|${cat.deleted}` : '-'].join('\u0001');
  }

  function buildRow(tx) {
    const rec = {
      id: tx.id, tx, el: null, content: null, del: null, sig: '', offset: 0, suppressClickUntil: 0,
    };
    rec.content = h('button', { type: 'button', class: 'home-row-content' });
    rec.del = h('button', {
      type: 'button', class: 'home-row-delete',
      on: {
        click: () => deleteRow(rec),
        focus: () => { if (!rec.dragging) openRowTo(rec); },
      },
    }, '删除');
    rec.el = h('li', { class: 'home-row', 'data-id': tx.id, 'data-flip': `t${tx.id}` }, rec.content, rec.del);
    rec.el.addEventListener('focusout', (e) => {
      if (rendering) return; // 重排列节点时 Chrome 也会发 focusout（relatedTarget=null），不算焦点离开
      if (openRow === rec && !rec.el.contains(e.relatedTarget)) closeRow(rec);
    });
    rec.content.addEventListener('click', () => onRowClick(rec));
    attachSwipe(rec);
    return rec;
  }

  function fillRow(rec, tx) {
    const cat = store.categoryById(tx.category_id);
    const sig = rowSig(tx, cat);
    rec.tx = tx;
    if (sig === rec.sig) return;
    rec.sig = sig;
    const name = cat ? cat.name : '未分类';
    const iconAttr = rowIconAttr(cat); // null → 灰色（已删除 / 未分类）
    const amount = tx.kind === 'income'
      ? formatRM(tx.amount_minor, { sign: 'always' })
      : formatRM(-tx.amount_minor);
    rec.content.replaceChildren(
      h('span', { class: `home-row-icon${iconAttr === null ? ' is-muted' : ''}`, 'data-icon': iconAttr }, icon(cat ? cat.icon : 'other', 22)),
      h('span', { class: 'home-row-text' },
        h('span', { class: 'home-row-name' }, name),
        tx.note ? h('span', { class: 'home-row-note' }, tx.note) : null),
      h('span', { class: `home-row-amount${tx.kind === 'income' ? ' is-income' : ''}` }, amount));
    rec.del.setAttribute('aria-label', `删除 ${name} ${amount}`);
  }

  // ---------- 渲染 ----------
  let dragging = 0;            // 正在拖动的列数；拖动中不重排 DOM（会让 pointer capture 失效）
  let renderPending = false;
  let rendering = false;       // render() 正在搬动 DOM
  let lastDays = new Set();    // 上一次画出的日期区块 key（判断新区块）
  const dayRecs = new Map();   // 日期区块 key → { el, labelEl, netEl, ul, label, net }（重用，不每次重建）
  const rowElOf = (k) => (k ? (rows.get(k.slice(1)) || {}).el : undefined);
  const dayElOf = (k) => (k ? (dayRecs.get(k) || {}).el : undefined);
  function buildDay(date) {
    const labelEl = h('span');
    const netEl = h('span', { class: 'home-day-net' });
    const ul = h('ul', { class: 'home-group', role: 'list' });
    const el = h('section', { class: 'home-day', 'data-flip': `d${date}` },
      h('h2', { class: 'home-day-header' }, labelEl, netEl), ul);
    return { el, labelEl, netEl, ul, label: null, net: null };
  }
  const activeDrags = new Set(); // 拖动中的列 record
  // reason：'data' 资料变动（会动画）、'wake' 从背景回来、'more' 显示更多。多次合并时 'data' 优先。
  // 有浮层（记一笔面板等）时延后到浮层关完、退场播完（whenIdle），动画才看得到。
  let pendingReason = null;
  let idleQueued = false;
  function requestRender(reason = 'data') {
    pendingReason = mergeReason(pendingReason, reason);
    // 浮层已关、只剩退场在播：卡片先画（数字马上滚），列表等 whenIdle。
    // 完全闲置时 whenIdle 会马上整页画（含卡片），这里不必先画
    if (!isIdle() && paintCardEarly({ depth: depth(), pendingReason })) {
      try { updateCard(pendingReason); } catch (e) { console.error(e); } // 卡片只是先画：出错也要照常排队画列表
    }
    if (dragging > 0) { renderPending = true; return; }
    if (idleQueued) return;
    idleQueued = true;
    // whenIdle 是唯一的判断来源：没有浮层、退场也播完 → 同步执行；否则排队
    whenIdle(() => {
      idleQueued = false;
      if (pendingReason === null) return;   // 已经画过了
      if (dragging > 0) { renderPending = true; return; }
      flushRender();
    });
  }
  function flushRender() {
    const r = pendingReason || 'data';
    pendingReason = null;
    render(r);
  }
  // 最上层浮层一关（例如记一笔存好）：卡片马上画；列表仍等退场播完（whenIdle）
  onDepthChange((d) => {
    if (paintCardEarly({ depth: d, pendingReason })) updateCard(pendingReason);
  });

  // ---------- 结余卡（切换眼睛只重画这一块，不重排账单列表） ----------
  let lastRatio = null;   // 比例线上一次的比例（滑入动画的起点）
  let painted = false;    // 第一次画卡片不动画
  // 重新算本月摘要并画卡片；资料变动时滚数字、飘字（本机刚新增的那笔）。不动 pendingReason（列表可能还没画）。
  // 列表画时会再呼叫一次：rollTo 字串相同直接返回、比例没变不取消，不会重播。回传全部交易给 render 用。
  function updateCard(reason) {
    today = todayLocal();
    const all = store.transactions();
    const month = monthOf(today);
    lastSummary = summarizeMonth(all, month);
    if (monthEl) monthEl.textContent = formatMonthTitle(month);
    const first = !painted;
    const anim = shouldAnimateCard({ first, hidden, reason });
    painted = true;
    paintCard(anim);
    // 资料变动就取走飘字标记（隐藏金额时也取走，免得之后显示金额再有变动时飘出旧的一笔）；只有 anim 才真的飘
    const floats = !first && reason === 'data' ? takeFloats() : [];
    if (anim) for (const id of floats) {
      const tx = all.find((t) => t.id === id);
      if (tx && monthOf(tx.occurred_on) === month) floatUp(tx); // 记在别的月份不飘
    }
    return all;
  }
  function paintCard(anim = false) {
    const eye = eyeButtonState(hidden);
    if (eyeBtn.getAttribute('aria-label') !== eye.label) { // 状态变了才换图示，不必每次 render 重建 SVG
      eyeBtn.setAttribute('aria-label', eye.label);
      eyeBtn.replaceChildren(icon(eye.icon, 22));
    }
    if (!lastSummary) return;
    const v = cardView(lastSummary, hidden);
    balSign.textContent = v.sign;
    balSign.hidden = !v.sign;
    // 数字滚轮：只有变的位数滚动（隐藏时 anim 一定是 false，直接显示 ••••）
    rollTo(balInt, v.int, { animate: anim });
    rollTo(balDec, v.dec, { animate: anim });
    balanceEl.className = `home-balance ${v.sizeCls}`.trim();
    balSr.textContent = v.balSr;
    for (const [f, d] of [[income, v.income], [expense, v.expense]]) {
      rollTo(f.vis, d.text, { animate: anim });
      f.sr.textContent = d.sr;
      f.el.className = `home-flow-v ${d.cls}`.trim();
    }
    const m = v.meter;
    meterBar.hidden = m.barHidden;
    meterBar.setAttribute('aria-label', m.label);
    // 比例线「滑入」：填充条固定 100% 宽，只改 translateX（不重排）；线隐藏时当作 0，之后从 0 滑入
    const ratio = m.barHidden ? 0 : m.pct / 100;
    if (!anim || ratio !== lastRatio) cancelAnims(meterFill);   // 比例没变就让正在滑的线滑完
    meterFill.style.transform = slideX(ratio);
    if (anim && lastRatio !== null && lastRatio !== ratio && !m.barHidden) {
      if (reducedMotion()) fade(meterFill, 'in');
      else animate(meterFill, [{ transform: slideX(lastRatio) }, { transform: slideX(ratio) }], { duration: DUR.bar });
    }
    lastRatio = ratio;
    meterNote.textContent = m.note;
    meterNote.classList.toggle('is-shown', m.noteShown);
    if (m.noteRead) meterNote.removeAttribute('aria-hidden');
    else meterNote.setAttribute('aria-hidden', 'true');
  }

  function setHidden(next) {
    hidden = next;
    writeHidden(storage, hidden);
    // 正在跑的滚动、比例线、飘字立刻停掉：切换眼睛本身不做动画，也不能露出金额（眼睛按钮自己的按压回弹不动）
    for (const el of [balanceEl, income.el, expense.el, meterFill]) cancelAnims(el, { subtree: true });
    for (const f of summary.querySelectorAll('.home-float')) f.remove();
    paintCard(false);
  }

  // 飘字：记账后卡片上飘出「+RM x / −RM x」再淡出（aria-hidden，读屏不重复读）
  function floatUp(tx) {
    for (const old of summary.querySelectorAll('.home-float')) old.remove(); // 连记两笔：不叠在一起
    const el = h('span', { class: `home-float${tx.kind === 'income' ? ' is-income' : ''}`, 'aria-hidden': 'true' }, floatText(tx));
    summary.append(el);
    const kf = reducedMotion()
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
      : [{ opacity: 0, transform: 'translateY(10px) scale(0.94)' },
        { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.25 },
        { opacity: 1, transform: 'translateY(-12px)', offset: 0.7 },
        { opacity: 0, transform: 'translateY(-24px)' }];
    const a = animate(el, kf, { duration: DUR.float, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    if (a) a.finished.then(() => el.remove(), () => el.remove());
    else el.remove();
  }

  function render(reason = 'data') {
    renderPending = false;
    const first = !painted;
    const all = updateCard(reason);
    // 本机刚存的 id：一律在这里取走（含空列表提前 return 的情况），有就走「不补位、只让新的一笔进场」
    const local = takeSavedForList();
    countEl.textContent = countText(all.length);

    const scrollY = window.scrollY;
    const hadFocus = list.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = hadFocus && hadFocus.closest('.home-row');
    const focusIdx = focusRow ? order.indexOf(focusRow.dataset.id) : -1;

    if (all.length === 0) {
      rows.clear();
      order = [];
      openRow = null;
      lastDays = new Set();
      dayRecs.clear();
      list.replaceChildren(h('p', { class: 'home-empty' }, '还没有记录，点上面的按钮记第一笔'));
      moreBtn.hidden = true;
      return;
    }

    const groups = groupByDate(all);
    const seen = new Set();
    const added = [];   // 这次新出现的列
    order = [];
    const dayOrder = [];
    // FLIP：资料变动时先量每一列与日期区块的位置（含进行中的位移），重画后从旧位置补位
    // 首页不在画面上（切到别的分页）时不做：量到的位置都是 0
    // 本机刚存（v2.3.1）：不量位置、不补位，只让新的一笔进场。列表这一帧落在数字滚动中段（遮罩 0.2 秒放行），
    // 所以要尽量轻：不量位置、节点重用（只插入一列）
    const before = !local.size && flipEnterable(reason, first) && !list.closest('[hidden]') ? snapshotTops(list) : null;
    if (before) pruneBefore(before, (id) => rows.has(id));
    const days = new Set();
    const dayEls = new Map();   // 日期区块 key → section（进场直接拿节点，不用 id 拼选择器）
    rendering = true; // 从这里开始会搬动列节点（insertBefore 时就离开旧位置，焦点可能掉）
    try {
      let budget = shown;
      for (const g of groups) {
        if (budget <= 0) break;
        const items = g.items.slice(0, budget);
        budget -= items.length;
        const keys = items.map((tx) => {
          let rec = rows.get(tx.id);
          if (!rec) { rec = buildRow(tx); rows.set(tx.id, rec); added.push(tx); }
          fillRow(rec, tx);
          seen.add(tx.id);
          order.push(tx.id);
          return `t${tx.id}`;
        });
        const key = `d${g.date}`;
        let d = dayRecs.get(key);
        if (!d) { d = buildDay(g.date); dayRecs.set(key, d); }
        // 区块重用：标题（今天 / 昨天…）与净额变了才改字；区块内的列只搬需要搬的
        const label = formatDayHeader(g.date, today);
        if (d.label !== label) { d.label = label; d.labelEl.textContent = label; d.el.setAttribute('aria-label', label); }
        const net = formatRM(g.net, { sign: 'always' });
        if (d.net !== net) { d.net = net; d.netEl.textContent = net; }
        syncChildren(d.ul, keys, rowElOf);
        days.add(key);
        dayEls.set(key, d.el);
        dayOrder.push(key);
      }
      for (const id of [...rows.keys()]) {
        if (!seen.has(id)) {
          if (openRow && openRow.id === id) openRow = null;
          rows.delete(id);
        }
      }
      for (const k of [...dayRecs.keys()]) if (!days.has(k)) dayRecs.delete(k);
      syncChildren(list, dayOrder, dayElOf);
    } finally {
      rendering = false;
    }
    moreBtn.hidden = all.length <= shown;
    const newDays = newDayKeys(days, lastDays);
    lastDays = days;

    // 保持滚动位置与焦点（重排列节点会让焦点掉到 body）
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    if (hadFocus && document.contains(hadFocus)) {
      if (document.activeElement !== hadFocus) hadFocus.focus({ preventScroll: true });
    } else if (focusIdx !== -1 && order.length) {
      // 有焦点的那列被删掉 → 焦点移到原位置的下一列（键盘 / VoiceOver 不会掉回页首）
      rows.get(order[Math.min(focusIdx, order.length - 1)]).content.focus({ preventScroll: true });
    }
    // 「之后」的位置要在还原 scrollY 之后量
    if (before) {
      // 只有这次新出现的列（新增、撤销）与新的日期区块才滑入；不在「之前」的其他列（例如第 201 笔补上来）不算
      const addedKeys = new Set(added.map((tx) => `t${tx.id}`));
      playFlip(list, before, {
        isEnter: (key) => key.startsWith('d') || addedKeys.has(key),
        skip: (el) => !!(rows.get(el.dataset.id) || {}).deleting,   // 正在滑出的列不要被补位动画盖掉
      });
    } else if (local.size && flipEnterable(reason, first) && !list.closest('[hidden]')) {
      // 不补位就不用等别的列让位：进场不加延迟（补位时 playFlip 会晚 40ms）
      const mine = added.filter((tx) => local.has(tx.id)).map((tx) => ({ rowKey: `t${tx.id}`, dayKey: `d${tx.occurred_on}` }));
      for (const key of enterTargets(mine, newDays)) {
        const el = key.startsWith('d') ? dayEls.get(key) : (rows.get(key.slice(1)) || {}).el;
        if (el) playEnter(el);
      }
    }
  }

  // ---------- 滑开 / 关闭 ----------
  function setOffset(rec, x, withTransition) {
    rec.offset = x;
    const anim = withTransition && !reducedMotion();
    rec.content.classList.toggle('is-animating', anim);
    rec.del.classList.toggle('is-animating', anim);
    rec.content.style.transform = x ? `translateX(${x}px)` : '';
    rec.del.style.width = `${Math.max(ACTION_W, -x)}px`;
    rec.el.classList.toggle('is-revealed', x < 0);
  }

  function openRowTo(rec) {
    if (openRow && openRow !== rec) closeRow(openRow);
    openRow = rec;
    openScrollY = window.scrollY;
    setOffset(rec, -ACTION_W, true);
  }

  function closeRow(rec) {
    if (openRow === rec) openRow = null;
    setOffset(rec, 0, true);
  }

  // 从外部关闭（点别处、Esc、按「＋ 记一笔」）：焦点若在这列的删除按钮上，先移回列内容，
  // 免得焦点留在看不见的删除按钮上、按 Enter 就在看不到的情况下删掉。
  function closeOpenRow() {
    if (!openRow) return;
    const rec = openRow;
    if (document.activeElement === rec.del) rec.content.focus({ preventScroll: true });
    closeRow(rec);
  }

  function onRowClick(rec) {
    if (rec.deleting) return;               // 正在滑出 / 删除中
    // 面板刚关、列表还没更新：先补画（同步，openEntrySheet 仍在点击里呼叫），这一列不在了就不做事
    if (pendingReason !== null && dragging === 0) {
      flushRender();
      if (rows.get(rec.id) !== rec) return;
    }
    if (!rowTapAllowed(pendingReason)) return; // 拖动中还没画：列上是旧资料
    const now = performance.now();
    if (now < rec.suppressClickUntil) return;                // 刚拖动过
    if (closingGesture || now < swallowClickUntil) return;   // 这一下是用来关闭别列的
    if (openRow) { closeOpenRow(); return; } // 有列滑开时，点一下只是关闭它
    openEntrySheet(store, { transaction: rec.tx, onAddCategory }); // 同步呼叫
  }

  // 左滑删除：整列先往左滑出＋淡出，播完才真的删除；之后 render 移除节点，下面的列由 FLIP 补位
  function slideOut(el) {
    cancelAnims(el, { id: 'flip' });   // 补位中按删除：直接从定位处滑出
    const a = reducedMotion()
      ? fade(el, 'out')
      : animate(el, [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-100%)', opacity: 0 }],
        { duration: DUR.rowOut, easing: EASE_OUT, fill: 'forwards' });
    if (!a) return Promise.resolve();
    a.id = 'row-out';
    // 被取消也照样删除；保险计时：App 进背景时动画会停，删除不能因此卡住
    return new Promise((resolve) => {
      const t = setTimeout(resolve, DUR.rowOut + 150);
      a.finished.then(() => {}, () => {}).then(() => { clearTimeout(t); resolve(); });
    });
  }

  function deleteRow(rec) {
    if (rec.deleting) return;
    // 列表还没更新：先补画，这一列不在了就不做事（被删或换成新节点）
    if (pendingReason !== null && dragging === 0) {
      flushRender();
      if (rows.get(rec.id) !== rec) return;
    }
    if (!rowTapAllowed(pendingReason)) { closeRow(rec); return; } // 拖动中还没画：这一笔可能已经被删或改了
    rec.deleting = true;
    if (openRow === rec) openRow = null;   // 滑出中点别处不要再把内容收回来
    const { id } = rec;
    slideOut(rec.el).then(() => store.deleteTransaction(id)).then(() => {
      // 旧 rec 从 rows 拿掉：重画被延后时按撤销，这一笔一定建新节点滑入（旧节点停在透明、也不能操作）
      if (rows.get(id) === rec) rows.delete(id);
      showToast('已删除', {
        actionLabel: '撤销',
        onAction: () => {
          store.restoreTransaction(id).catch((e) => {
            console.error(e);
            messageDialog({ title: '撤销失败', message: '这笔记录没能还原，请稍后再试。' });
          });
        },
      });
    }, (e) => {
      console.error(e);
      rec.deleting = false;
      cancelAnims(rec.el, { id: 'row-out' });   // 列回到原位
      // 焦点若在（即将被收起的）删除按钮上，先移回列内容
      if (document.activeElement === rec.del) rec.content.focus({ preventScroll: true });
      closeRow(rec);
      messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
    });
  }

  // ---------- 左滑手势（pointer events，垂直滚动优先） ----------
  // 拖动状态必须成对：每次 dragging += 1 都只能由 finish() 减回来一次。
  // 拖动中的列登记在 activeDrags；新的主要指标按下、或指标在列外放开时，由文件层的后备逻辑收尾，
  // 避免失去 capture 又收不到 pointerup 时 dragging 永远不归零（列表与摘要就不会再更新）。
  function attachSwipe(rec) {
    const c = rec.content;
    let g = null; // { pid, x0, y0, base, state: 'pending'|'drag', lostTimer }

    // 结束指定的手势（只对仍是目前手势的 gs 生效，旧计时器不会清掉新手势）
    function finish(gs, cancelled) {
      if (!gs || g !== gs) return;
      clearTimeout(gs.lostTimer);
      g = null;
      if (gs.state !== 'drag') return;
      activeDrags.delete(rec);
      rec.dragging = false;
      dragging -= 1;
      rec.suppressClickUntil = performance.now() + CLICK_WINDOW; // 拖动后的 click 不要打开 sheet
      const w = rec.el.clientWidth;
      const pulled = -rec.offset;
      if (!cancelled && pulled > w * FULL_RATIO) {
        if (openRow === rec) openRow = null;
        setOffset(rec, -w, true);
        deleteRow(rec);
      } else if (pulled > OPEN_MIN) {
        openRowTo(rec);   // 被中断（cancel / 失去 capture）时停到最近的状态，不删除
      } else {
        closeRow(rec);
      }
      if (renderPending && dragging === 0) { renderPending = false; requestRender(pendingReason || 'data'); }
    }
    rec.finishDrag = (cancelled) => finish(g, cancelled);
    rec.dragPointerId = () => (g ? g.pid : null);

    c.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || rec.deleting) return;
      finish(g, true); // 上一个手势没收到 pointerup（例如失去 capture）→ 先收尾，计数保持配对
      g = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, base: rec.offset, state: 'pending', lostTimer: 0 };
    });

    c.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.pid) return;
      clearTimeout(g.lostTimer); // 还收得到 move → 手势仍在进行
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (g.state === 'pending') {
        if (Math.hypot(dx, dy) < LOCK_DIST) return;
        if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // 偏垂直 → 放弃，让页面滚动
        if (dx > 0 && g.base === 0) { g = null; return; }      // 关着的列往右滑：不处理
        g.state = 'drag';
        rec.dragging = true;
        dragging += 1;
        activeDrags.add(rec);
        if (openRow && openRow !== rec) closeRow(openRow);
        try { c.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      }
      const w = rec.el.clientWidth;
      setOffset(rec, Math.max(-w, Math.min(0, g.base + dx)), false);
    });

    const onEnd = (cancelled) => (e) => { if (g && e.pointerId === g.pid) finish(g, cancelled); };
    c.addEventListener('pointerup', onEnd(false));
    c.addEventListener('pointercancel', onEnd(true));
    // 失去 capture：Chrome 在 touch 的隐式 capture 换成显式 capture 时会先发 lost 再发 got，
    // 所以不立刻结束；短时间内没有拿回 capture、也没有新的 move，才当作中断（停到最近状态）。
    // 正常 pointerup 之后 g 已清空 → 不做事。
    c.addEventListener('lostpointercapture', (e) => {
      if (!g || e.pointerId !== g.pid || g.state !== 'drag') return;
      const gs = g;
      clearTimeout(gs.lostTimer);
      gs.lostTimer = setTimeout(() => finish(gs, true), LOST_GRACE);
    });
    c.addEventListener('gotpointercapture', (e) => {
      if (g && e.pointerId === g.pid) clearTimeout(g.lostTimer);
    });
  }

  // 后备：拖动中的列若已失去 capture，pointerup / cancel 可能落在别处 → 在文件层收尾（当作中断）。
  // 落在该列内容上的事件交给列自己的 handler（不重复处理）。
  const finishStrayDrags = (e) => {
    for (const rec of [...activeDrags]) {
      if (rec.dragPointerId() === e.pointerId && !rec.content.contains(e.target)) rec.finishDrag(true);
    }
  };
  document.addEventListener('pointerup', finishStrayDrags, true);
  document.addEventListener('pointercancel', finishStrayDrags, true);
  // 新的主要指标按下 = 之前的主要指标早已放开；还挂着的拖动一律收尾
  document.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    for (const rec of [...activeDrags]) {
      if (rec.dragPointerId() !== e.pointerId || !rec.content.contains(e.target)) rec.finishDrag(true);
    }
  }, true);

  // 点其他地方 / 滚动 → 关闭滑开的列
  document.addEventListener('pointerdown', (e) => {
    closingGesture = false;
    swallowClickUntil = 0;
    if (openRow && !openRow.el.contains(e.target)) {
      closingGesture = list.contains(e.target);
      closeOpenRow();
    }
  }, true);
  const endGesture = () => {
    if (!closingGesture) return;
    closingGesture = false;
    swallowClickUntil = performance.now() + CLICK_WINDOW;
  };
  document.addEventListener('pointerup', endGesture, true);
  document.addEventListener('pointercancel', endGesture, true);
  window.addEventListener('scroll', () => {
    // 键盘聚焦删除按钮时浏览器会把它滚进画面；重新渲染时还原 scrollY 也会发 scroll 事件。
    // 这两种都不能把列关掉 → 焦点在删除按钮上时不关；其余只在 scrollY 真的离开打开时的位置才关。
    if (!openRow || openRow.dragging || document.activeElement === openRow.del) return;
    if (Math.abs(window.scrollY - openScrollY) > 4) closeOpenRow();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRow && depth() === 0) closeOpenRow();
  });

  // ---------- 更新时机 ----------
  store.subscribe(() => requestRender('data'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayLocal() !== today) requestRender('wake');
  });

  render();
}
