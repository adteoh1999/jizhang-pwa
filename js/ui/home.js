// 首页：本月结余卡（光晕 + 比例线）、黑色「记一笔」、账单抽屉（按日期分组，左滑删除 + 撤销）。
// 注意：entry-sheet.js 必须静态导入，openEntrySheet 必须在点击事件里同步呼叫（不能先 await），
// iOS 才会在金额框 focus() 时弹出键盘。
//
// 无障碍删除路径：每一列的红色「删除」按钮一直在 DOM 里（排在列内容之后），
// 键盘 Tab / VoiceOver 都能直接到达并启动，不必左滑；键盘焦点落在它上面时，该列自动滑开露出按钮。
import { h } from './dom.js';
import { icon, iconKey } from './icons.js';
import { openEntrySheet } from './entry-sheet.js';
import { openCategoriesPage } from './categories-page.js';
import { showToast } from './toast.js';
import { messageDialog } from './dialogs.js';
import { depth } from './nav.js';
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
  return { int: (minor < 0 ? '\u2212' : '') + i, dec: `.${f}` };
}

/** 依整数部分字元数（含逗号、不含「RM 」与符号）决定大数字缩级：≤6 → ''，7–9 → is-long，≥10 → is-xlong。 */
export function balanceSizeClass(minor) {
  const n = formatRM(minor, { sign: 'none' }).slice(3).split('.')[0].length;
  return n >= 10 ? 'is-xlong' : n >= 7 ? 'is-long' : '';
}

/** 列图示的 data-icon：有效分类 → iconKey；已删除 / 未分类 → null（维持灰色）。 */
export function rowIconAttr(cat) {
  return cat && !cat.deleted ? iconKey(cat.icon) : null;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountHome(root, store, { monthEl = null } = {}) {
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
  let openScrollY = 0;         // 列滑开时的 scrollY；只有真的捲离这个位置才关闭
  // 记一笔里的「＋ 新增」：叠一层分类管理子画面，新增后回到记一笔并选中新分类
  const onAddCategory = ({ kind, select, refocus }) => openCategoriesPage(store, {
    kind, from: 'entry', onPicked: select, restoreFocus: refocus,
  });

  // ---------- 静态骨架 ----------
  // 结余卡：光晕是 .home-card::before（静态渐层，被卡片裁切）
  // 视觉上拆成三段（aria-hidden），读屏读完整金额（.sr-only）
  const balSr = h('span', { class: 'sr-only' });
  const balInt = h('span', { class: 'home-balance-int', 'aria-hidden': 'true' });
  const balDec = h('span', { class: 'home-balance-dec', 'aria-hidden': 'true' });
  const balanceEl = h('p', { class: 'home-balance' },
    balSr, h('span', { class: 'home-balance-cur', 'aria-hidden': 'true' }, 'RM'), balInt, balDec);
  const incomeEl = h('span', { class: 'home-flow-v' });
  const expenseEl = h('span', { class: 'home-flow-v' });
  const flowCol = (name, label, valueEl) => h('div', { class: 'home-flow-item' },
    h('span', { class: 'home-flow-k' }, icon(name, 12), label), valueEl);
  const meterFill = h('i', { class: 'home-meter-fill' });
  const meterBar = h('div', { class: 'home-meter-bar', role: 'img' }, meterFill);
  const meterNote = h('span', { class: 'home-meter-note' });
  const summary = h('section', { class: 'home-card', 'aria-labelledby': 'home-card-label' },
    h('h2', { class: 'home-card-label', id: 'home-card-label' }, '本月结余'),
    balanceEl,
    h('div', { class: 'home-flow' },
      flowCol('arrow-up', '收入', incomeEl),
      flowCol('arrow-down', '支出', expenseEl)),
    h('div', { class: 'home-meter' }, meterBar, meterNote));

  const addBtn = h('button', {
    type: 'button', class: 'home-add pressable',
    on: { click: () => { closeOpenRow(); openEntrySheet(store, { onAddCategory }); } }, // 同步呼叫
  }, icon('plus', 20), '记一笔');

  const countEl = h('span', { class: 'home-drawer-count' });
  const list = h('div', { class: 'home-list' });
  const moreBtn = h('button', {
    type: 'button', class: 'home-more', hidden: true,
    on: { click: () => { shown += PAGE; requestRender(); } },
  }, '显示更多');

  // 账单抽屉：白底上圆角，阴影挂在 .home-drawer::before；最少撑到画面底部（CSS flex）
  const drawer = h('section', { class: 'home-drawer', 'aria-labelledby': 'home-drawer-title' },
    h('div', { class: 'home-drawer-head' },
      h('h2', { class: 'home-drawer-title', id: 'home-drawer-title' }, '账单'), countEl),
    list, moreBtn);

  root.replaceChildren(summary, addBtn, drawer);

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
    rec.el = h('li', { class: 'home-row', 'data-id': tx.id }, rec.content, rec.del);
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
    const amount = tx.kind === 'income'
      ? formatRM(tx.amount_minor, { sign: 'always' })
      : formatRM(-tx.amount_minor);
    rec.content.replaceChildren(
      h('span', { class: `home-row-icon${!cat || cat.deleted ? ' is-muted' : ''}`, 'data-icon': rowIconAttr(cat) }, icon(cat ? cat.icon : 'other', 22)),
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
  const activeDrags = new Set(); // 拖动中的列 record
  function requestRender() {
    if (dragging > 0) { renderPending = true; return; }
    render();
  }

  function render() {
    renderPending = false;
    today = todayLocal();
    const all = store.transactions();
    const month = monthOf(today);
    const s = summarizeMonth(all, month);
    if (monthEl) monthEl.textContent = formatMonthTitle(month);
    const bp = balanceParts(s.balance);
    balInt.textContent = bp.int;
    balDec.textContent = bp.dec;
    balanceEl.className = `home-balance ${balanceSizeClass(s.balance)}`.trim();
    balSr.textContent = formatRM(s.balance);
    incomeEl.textContent = formatRM(s.income, { sign: 'none' });
    expenseEl.textContent = formatRM(s.expense, { sign: 'none' });
    const m = spendMeter(s.income, s.expense);
    const meterText = m.state === 'none' ? '本月还没有收入'
      : m.state === 'over' ? '支出已超过收入' : `已花掉收入的 ${m.pct}%`;
    meterBar.hidden = m.state === 'none';
    meterBar.setAttribute('aria-label', meterText);
    meterFill.style.width = `${m.pct}%`;
    meterNote.textContent = meterText;
    // 线条显示时由它（role=img）读出，文字不重复读；线条隐藏时由文字读出
    if (m.state === 'none') meterNote.removeAttribute('aria-hidden');
    else meterNote.setAttribute('aria-hidden', 'true');
    countEl.textContent = `共 ${all.length} 笔`;

    const scrollY = window.scrollY;
    const hadFocus = list.contains(document.activeElement) ? document.activeElement : null;
    const focusRow = hadFocus && hadFocus.closest('.home-row');
    const focusIdx = focusRow ? order.indexOf(focusRow.dataset.id) : -1;

    if (all.length === 0) {
      rows.clear();
      order = [];
      openRow = null;
      list.replaceChildren(h('p', { class: 'home-empty' }, '还没有记录，点上面的按钮记第一笔'));
      moreBtn.hidden = true;
      return;
    }

    const groups = groupByDate(all);
    const seen = new Set();
    order = [];
    const frag = [];
    rendering = true; // 从这里开始列节点会被搬到新的 <ul>（append 时就离开旧位置）
    try {
      let budget = shown;
      for (const g of groups) {
        if (budget <= 0) break;
        const items = g.items.slice(0, budget);
        budget -= items.length;
        const lis = items.map((tx) => {
          let rec = rows.get(tx.id);
          if (!rec) { rec = buildRow(tx); rows.set(tx.id, rec); }
          fillRow(rec, tx);
          seen.add(tx.id);
          order.push(tx.id);
          return rec.el;
        });
        frag.push(h('section', { class: 'home-day', 'aria-label': formatDayHeader(g.date, today) },
          h('h2', { class: 'home-day-header' },
            h('span', null, formatDayHeader(g.date, today)),
            h('span', { class: 'home-day-net' }, formatRM(g.net, { sign: 'always' }))),
          h('ul', { class: 'home-group', role: 'list' }, lis)));
      }
      for (const id of [...rows.keys()]) {
        if (!seen.has(id)) {
          if (openRow && openRow.id === id) openRow = null;
          rows.delete(id);
        }
      }
      list.replaceChildren(...frag);
    } finally {
      rendering = false;
    }
    moreBtn.hidden = all.length <= shown;

    // 保持捲动位置与焦点（重排列节点会让焦点掉到 body）
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    if (hadFocus && document.contains(hadFocus)) {
      if (document.activeElement !== hadFocus) hadFocus.focus({ preventScroll: true });
    } else if (focusIdx !== -1 && order.length) {
      // 有焦点的那列被删掉 → 焦点移到原位置的下一列（键盘 / VoiceOver 不会掉回页首）
      rows.get(order[Math.min(focusIdx, order.length - 1)]).content.focus({ preventScroll: true });
    }
  }

  // ---------- 滑开 / 关闭 ----------
  function setOffset(rec, x, animate) {
    rec.offset = x;
    const anim = animate && !reducedMotion();
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
    const now = performance.now();
    if (now < rec.suppressClickUntil) return;                // 刚拖动过
    if (closingGesture || now < swallowClickUntil) return;   // 这一下是用来关闭别列的
    if (openRow) { closeOpenRow(); return; } // 有列滑开时，点一下只是关闭它
    openEntrySheet(store, { transaction: rec.tx, onAddCategory }); // 同步呼叫
  }

  function deleteRow(rec) {
    if (rec.deleting) return;
    rec.deleting = true;
    const { id } = rec;
    store.deleteTransaction(id).then(() => {
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
      // 焦点若在（即将被收起的）删除按钮上，先移回列内容
      if (document.activeElement === rec.del) rec.content.focus({ preventScroll: true });
      closeRow(rec);
      messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
    });
  }

  // ---------- 左滑手势（pointer events，垂直捲动优先） ----------
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
      if (renderPending && dragging === 0) render();
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
        if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // 偏垂直 → 放弃，让页面捲动
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

  // 点其他地方 / 捲动 → 关闭滑开的列
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
    // 键盘聚焦删除按钮时浏览器会把它捲进画面；重新渲染时还原 scrollY 也会发 scroll 事件。
    // 这两种都不能把列关掉 → 焦点在删除按钮上时不关；其余只在 scrollY 真的离开打开时的位置才关。
    if (!openRow || openRow.dragging || document.activeElement === openRow.del) return;
    if (Math.abs(window.scrollY - openScrollY) > 4) closeOpenRow();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRow && depth() === 0) closeOpenRow();
  });

  // ---------- 更新时机 ----------
  store.subscribe(requestRender);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayLocal() !== today) requestRender();
  });

  render();
}
