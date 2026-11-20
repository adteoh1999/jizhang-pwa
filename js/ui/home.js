// 首页：本月摘要卡、「＋ 记一笔」、按日期分组的账单列表（左滑删除 + 撤销）。
// 注意：entry-sheet.js 必须静态导入，openEntrySheet 必须在点击事件里同步呼叫（不能先 await），
// iOS 才会在金额框 focus() 时弹出键盘。
//
// 无障碍删除路径：每一列的红色「删除」按钮一直在 DOM 里（排在列内容之后），
// 键盘 Tab / VoiceOver 都能直接到达并启动，不必左滑；键盘焦点落在它上面时，该列自动滑开露出按钮。
import { h } from './dom.js';
import { icon } from './icons.js';
import { openEntrySheet } from './entry-sheet.js';
import { showToast } from './toast.js';
import { messageDialog } from './dialogs.js';
import { depth } from './nav.js';
import { summarizeMonth, groupByDate } from '../stats.js';
import { formatRM } from '../money.js';
import { todayLocal, monthOf, formatDayHeader } from '../dates.js';

const PAGE = 200;            // 一次显示的笔数
const ACTION_W = 80;         // 「删除」按钮宽度
const OPEN_MIN = 40;         // 放开时滑超过这个距离 → 停在打开
const FULL_RATIO = 0.6;      // 滑过列宽 60% → 直接删除
const LOCK_DIST = 10;        // 判断方向前要移动的距离

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountHome(root, store) {
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

  // ---------- 静态骨架 ----------
  const sumTitle = h('h2', { class: 'home-summary-title' }, '本月');
  const sumMonth = h('span', { class: 'home-summary-month' });
  const incomeEl = h('span', { class: 'home-summary-value is-income' });
  const expenseEl = h('span', { class: 'home-summary-value' });
  const balanceEl = h('span', { class: 'home-summary-value' });
  const summaryRow = (label, valueEl) => h('div', { class: 'home-summary-row' },
    h('span', { class: 'home-summary-label' }, label), valueEl);
  const summary = h('section', { class: 'home-summary', 'aria-labelledby': 'home-summary-title' },
    h('div', { class: 'home-summary-head' }, sumTitle, sumMonth),
    summaryRow('收入', incomeEl),
    summaryRow('支出', expenseEl),
    summaryRow('结余', balanceEl));
  sumTitle.id = 'home-summary-title';

  const addBtn = h('button', {
    type: 'button', class: 'home-add pressable',
    on: { click: () => { closeOpenRow(); openEntrySheet(store, {}); } }, // 同步呼叫
  }, '＋ 记一笔');

  const list = h('div', { class: 'home-list' });
  const moreBtn = h('button', {
    type: 'button', class: 'home-more', hidden: true,
    on: { click: () => { shown += PAGE; render(); } },
  }, '显示更多');

  root.replaceChildren(summary, addBtn, list, moreBtn);

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
      h('span', { class: `home-row-icon${!cat || cat.deleted ? ' is-muted' : ''}` }, icon(cat ? cat.icon : 'other', 20)),
      h('span', { class: 'home-row-text' },
        h('span', { class: 'home-row-name' }, name),
        tx.note ? h('span', { class: 'home-row-note' }, tx.note) : null),
      h('span', { class: `home-row-amount${tx.kind === 'income' ? ' is-income' : ''}` }, amount));
    rec.del.setAttribute('aria-label', `删除 ${name} ${amount}`);
  }

  // ---------- 渲染 ----------
  function render() {
    today = todayLocal();
    const all = store.transactions();
    const month = monthOf(today);
    const s = summarizeMonth(all, month);
    sumMonth.textContent = `${Number(month.slice(5))} 月`;
    incomeEl.textContent = formatRM(s.income, { sign: 'none' });
    expenseEl.textContent = formatRM(s.expense, { sign: 'none' });
    balanceEl.textContent = formatRM(s.balance);

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
          h('span', { class: 'home-day-net' }, formatRM(g.net))),
        h('ul', { class: 'home-group', role: 'list' }, lis)));
    }
    for (const id of [...rows.keys()]) {
      if (!seen.has(id)) {
        if (openRow && openRow.id === id) openRow = null;
        rows.delete(id);
      }
    }
    list.replaceChildren(...frag);
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
    setOffset(rec, -ACTION_W, true);
  }

  function closeRow(rec) {
    if (openRow === rec) openRow = null;
    setOffset(rec, 0, true);
  }

  function closeOpenRow() {
    if (openRow) closeRow(openRow);
  }

  function onRowClick(rec) {
    const now = performance.now();
    if (now < rec.suppressClickUntil) return;                // 刚拖动过
    if (closingGesture || now < swallowClickUntil) return;   // 这一下是用来关闭别列的
    if (openRow) { closeOpenRow(); return; } // 有列滑开时，点一下只是关闭它
    openEntrySheet(store, { transaction: rec.tx }); // 同步呼叫
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
            messageDialog({ title: '撤销失败', message: '这笔纪录没能还原，请稍后再试。' });
          });
        },
      });
    }, (e) => {
      console.error(e);
      rec.deleting = false;
      closeRow(rec);
      messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
    });
  }

  // ---------- 左滑手势（pointer events，垂直捲动优先） ----------
  function attachSwipe(rec) {
    const c = rec.content;
    let g = null; // { pid, x0, y0, base, state: 'pending'|'drag' }

    c.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || rec.deleting) return;
      g = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, base: rec.offset, state: 'pending' };
    });

    c.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.pid) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (g.state === 'pending') {
        if (Math.hypot(dx, dy) < LOCK_DIST) return;
        if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // 偏垂直 → 放弃，让页面捲动
        g.state = 'drag';
        rec.dragging = true;
        if (openRow && openRow !== rec) closeRow(openRow);
        try { c.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      }
      const w = rec.el.clientWidth;
      setOffset(rec, Math.max(-w, Math.min(0, g.base + dx)), false);
    });

    const end = (e, cancelled) => {
      if (!g || e.pointerId !== g.pid) return;
      const wasDrag = g.state === 'drag';
      g = null;
      if (!wasDrag) return;
      rec.dragging = false;
      rec.suppressClickUntil = performance.now() + CLICK_WINDOW; // 拖动后的 click 不要打开 sheet
      const w = rec.el.clientWidth;
      const pulled = -rec.offset;
      if (!cancelled && pulled > w * FULL_RATIO) {
        if (openRow === rec) openRow = null;
        setOffset(rec, -w, true);
        deleteRow(rec);
      } else if (!cancelled && pulled > OPEN_MIN) {
        openRowTo(rec);
      } else {
        closeRow(rec);
      }
    };
    c.addEventListener('pointerup', (e) => end(e, false));
    c.addEventListener('pointercancel', (e) => end(e, true));
  }

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
    if (openRow && !openRow.dragging) closeOpenRow();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openRow && depth() === 0) closeOpenRow();
  });

  // ---------- 更新时机 ----------
  store.subscribe(render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayLocal() !== today) render();
  });

  render();
}
