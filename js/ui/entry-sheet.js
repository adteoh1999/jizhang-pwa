// 记一笔 / 编辑：金额（大字）、支出/收入、分类网格、日期、备注；编辑模式多一个「删除这笔」。
// 注意：openEntrySheet 必须在使用者的点击事件里「同步」呼叫——金额框的 focus() 在任何 await 之前，
// iOS 才会弹出键盘。
import { h } from './dom.js';
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { actionSheet, messageDialog } from './dialogs.js';
import { showToast } from './toast.js';
import { parseAmount, minorToDecimalString } from '../money.js';
import { todayLocal, isValidDateString } from '../dates.js';
import { ValidationError, NOTE_MAX } from '../model.js';
import { uuid } from '../uuid.js';

const KINDS = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
];
const MAX_DAYS_AHEAD = 365;

let seq = 0;

// 'YYYY-MM-DD' → 天数序号（与时区无关）
const dayNumber = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** 储存前的栏位检查（store 也会再验证一次）；回传 { field, message } 或 null。 */
function checkFields({ amountText, date }) {
  if (amountText.trim() === '') return { field: 'amount', message: '请输入金额' };
  if (parseAmount(amountText) === null) return { field: 'amount', message: '金额格式不对' };
  if (date === '') return { field: 'date', message: '请选择日期' };
  if (!isValidDateString(date)) return { field: 'date', message: '请选择日期' };
  if (dayNumber(date) - dayNumber(todayLocal()) > MAX_DAYS_AHEAD) return { field: 'date', message: '日期太远了' };
  return null;
}

// store 抛出的 ValidationError.field → 中文讯息（绝不直接显示 e.message）；未知栏位 → null
function messageFor(field, { amountText, date }, categoryMissing) {
  switch (field) {
    case 'amount': return amountText.trim() === '' ? '请输入金额' : '金额格式不对';
    case 'date': return date === '' ? '请选择日期' : '日期太远了';
    case 'note': return `备注最多 ${NOTE_MAX} 字`;
    case 'category': return categoryMissing ? '请选择其他分类' : '请选择分类';
    default: return null;
  }
}

/**
 * openEntrySheet(store, { transaction?, onAddCategory? }) → { close }
 * onAddCategory({ kind })：有给才显示「＋ 新增」（Task 12 接上分类管理）。
 */
export function openEntrySheet(store, { transaction, onAddCategory } = {}) {
  const tx = transaction || null;
  const id = tx ? tx.id : uuid(); // 打开时就决定 id：连点储存只会覆盖同一笔
  const uid = `entry-${++seq}`;

  const initial = {
    kind: tx ? tx.kind : 'expense',
    amountText: tx ? minorToDecimalString(tx.amount_minor) : '',
    categoryId: tx ? tx.category_id : (store.categories('expense')[0] || {}).id || null,
    date: tx ? tx.occurred_on : todayLocal(),
    note: tx ? tx.note : '',
  };
  // byKind：每个类型各自记住选中的分类，切换类型再切回来时还原（不悄悄换掉使用者没碰过的分类）
  const state = {
    kind: initial.kind,
    categoryId: initial.categoryId,
    byKind: { [initial.kind]: initial.categoryId },
  };
  let saving = false;

  // ---------- 金额 ----------
  const amountInput = h('input', {
    class: 'entry-amount-input', id: `${uid}-amount`, type: 'text', inputmode: 'decimal',
    autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
    placeholder: '0.00', 'aria-label': '金额（RM）',
  });
  amountInput.value = initial.amountText;
  const amountError = h('p', { class: 'field-error', id: `${uid}-amount-err`, role: 'alert', hidden: true });
  const amountField = h('div', { class: 'entry-amount' },
    h('label', { class: 'entry-amount-row', for: `${uid}-amount` },
      h('span', { class: 'entry-amount-prefix', 'aria-hidden': 'true' }, 'RM'),
      amountInput),
    amountError);

  // ---------- 支出 / 收入 ----------
  const segButtons = KINDS.map((k) => h('button', {
    type: 'button', role: 'radio', class: 'segment', 'data-kind': k.id,
    on: { click: () => setKind(k.id) },
  }, k.label));
  const segmented = h('div', {
    class: 'segmented', role: 'radiogroup', 'aria-label': '类型',
    on: {
      keydown: (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const next = state.kind === 'expense' ? 'income' : 'expense';
        setKind(next);
        segButtons.find((b) => b.dataset.kind === next).focus();
      },
    },
  }, segButtons);

  // ---------- 分类网格 ----------
  const grid = h('div', { class: 'cat-grid', role: 'group', 'aria-labelledby': `${uid}-cat-label` });
  const catError = h('p', { class: 'field-error', id: `${uid}-cat-err`, role: 'alert', hidden: true });
  const catField = h('div', { class: 'entry-section' },
    h('h3', { class: 'entry-section-label', id: `${uid}-cat-label` }, '分类'),
    h('div', { class: 'entry-card cat-card' }, grid),
    catError);

  function tile({ catId, name, iconName, deleted = false }) {
    const selected = catId === state.categoryId;
    return h('button', {
      type: 'button', class: `cat-tile${deleted ? ' is-deleted' : ''}`,
      'aria-pressed': selected ? 'true' : 'false', 'data-cat': catId,
      'aria-label': deleted ? `${name}（已删除）` : name,
      on: {
        click: () => {
          state.categoryId = catId;
          state.byKind[state.kind] = catId;
          clearError(catField, catError);
          renderGrid();
        },
      },
    },
    h('span', { class: 'cat-tile-icon' }, icon(iconName, 22)),
    h('span', { class: 'cat-tile-name' }, name),
    deleted ? h('span', { class: 'cat-tile-badge' }, '已删除') : null);
  }

  function renderGrid() {
    const cats = store.categories(state.kind);
    const active = new Set(cats.map((c) => c.id));
    const tiles = [];
    // 不在活动列表里的分类（已删除 / 查不到）放在最前面：
    // - 原本这笔的分类：只要在原本的类型下就一直显示（选中与否），使用者可以再点回来；
    // - 目前选中的分类（例如 sheet 开着时被删）：保持显示与选中，绝不悄悄换掉。
    const extras = [];
    if (state.kind === initial.kind && initial.categoryId && !active.has(initial.categoryId)) {
      extras.push(initial.categoryId);
    }
    const sel = state.categoryId;
    if (sel && !active.has(sel) && !extras.includes(sel)) {
      const c = store.categoryById(sel);
      if (c && c.kind === state.kind) extras.push(sel);
    }
    for (const xid of extras) {
      const c = store.categoryById(xid);
      tiles.push(tile({
        catId: xid, name: c ? c.name : '未分类', iconName: c ? c.icon : 'other', deleted: !!c,
      }));
    }
    for (const c of cats) tiles.push(tile({ catId: c.id, name: c.name, iconName: c.icon }));
    if (onAddCategory) {
      tiles.push(h('button', {
        type: 'button', class: 'cat-tile cat-tile-add', 'aria-label': '新增分类',
        on: { click: () => onAddCategory({ kind: state.kind }) },
      },
      h('span', { class: 'cat-tile-icon' }, h('span', { class: 'cat-tile-plus', 'aria-hidden': 'true' }, '＋')),
      h('span', { class: 'cat-tile-name' }, '新增')));
    }
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.cat : null;
    grid.replaceChildren(...tiles);
    if (hadFocus) {
      const again = [...grid.children].find((b) => b.dataset.cat === hadFocus);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function syncSegments() {
    for (const b of segButtons) {
      const on = b.dataset.kind === state.kind;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    segmented.dataset.selected = state.kind; // CSS 用来滑动选中的底块
  }

  function setKind(kind) {
    if (state.kind === kind) return;
    state.kind = kind;
    // 还原这个类型上次的选择；仍有效（活动分类，或原本这笔的分类）才用，否则选该类型第一个
    const cats = store.categories(kind);
    const remembered = state.byKind[kind];
    const valid = remembered && (cats.some((c) => c.id === remembered)
      || (kind === initial.kind && remembered === initial.categoryId));
    state.categoryId = valid ? remembered : ((cats[0] || {}).id || null);
    state.byKind[kind] = state.categoryId;
    syncSegments();
    clearError(catField, catError);
    renderGrid();
  }

  // ---------- 日期、备注 ----------
  const dateInput = h('input', { class: 'entry-input', id: `${uid}-date`, type: 'date' });
  dateInput.value = initial.date;
  const noteInput = h('input', {
    class: 'entry-input entry-note', id: `${uid}-note`, type: 'text', maxlength: String(NOTE_MAX),
    placeholder: '备注（选填）', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': '备注',
  });
  noteInput.value = initial.note;
  const dateError = h('p', { class: 'field-error', id: `${uid}-date-err`, role: 'alert', hidden: true });
  const noteError = h('p', { class: 'field-error', id: `${uid}-note-err`, role: 'alert', hidden: true });
  const dateRow = h('label', { class: 'entry-row', for: `${uid}-date` },
    h('span', { class: 'entry-row-label' }, '日期'), dateInput);
  const noteRow = h('div', { class: 'entry-row' }, noteInput);
  const detailField = h('div', { class: 'entry-section' },
    h('div', { class: 'entry-card entry-list' }, dateRow, noteRow),
    dateError, noteError);

  // ---------- 删除（编辑模式） ----------
  const deleteButton = tx
    ? h('button', { type: 'button', class: 'entry-delete', on: { click: () => confirmDelete() } }, '删除这笔')
    : null;

  const content = h('div', { class: 'entry' },
    segmented, amountField, catField, detailField,
    deleteButton ? h('div', { class: 'entry-section' }, deleteButton) : null);

  // ---------- 错误显示 ----------
  const fields = {
    amount: { box: amountField, err: amountError, input: amountInput },
    date: { box: detailField, err: dateError, input: dateInput },
    note: { box: detailField, err: noteError, input: noteInput },
    category: { box: catField, err: catError, input: null, describe: grid },
  };

  function clearError(box, err) {
    if (err.hidden) return;
    err.hidden = true;
    err.textContent = '';
    box.classList.remove('has-error');
    for (const f of Object.values(fields)) {
      if (f.err !== err) continue;
      if (f.input) f.input.removeAttribute('aria-invalid');
      (f.input || f.describe).removeAttribute('aria-describedby');
    }
  }
  function clearAllErrors() {
    for (const f of Object.values(fields)) clearError(f.box, f.err);
  }

  function showError(field, message) {
    const f = fields[field];
    f.err.textContent = message;
    f.err.hidden = false; // role=alert：VoiceOver 会读出
    f.box.classList.add('has-error');
    const target = f.input || grid.querySelector('[aria-pressed="true"]') || grid.querySelector('button');
    if (f.input) f.input.setAttribute('aria-invalid', 'true');
    (f.input || f.describe).setAttribute('aria-describedby', f.err.id);
    // 抖一下（reduced motion 时 CSS 不做动画）
    const shake = field === 'date' ? dateRow : field === 'note' ? noteRow : field === 'amount' ? amountField.firstChild : grid;
    shake.classList.remove('is-shaking');
    void shake.offsetWidth; // 重新触发动画
    shake.classList.add('is-shaking');
    setTimeout(() => shake.classList.remove('is-shaking'), 500);
    if (target) target.focus({ preventScroll: false });
  }

  amountInput.addEventListener('input', () => clearError(amountField, amountError));
  dateInput.addEventListener('input', () => clearError(detailField, dateError));
  dateInput.addEventListener('change', () => clearError(detailField, dateError));
  noteInput.addEventListener('input', () => clearError(detailField, noteError));
  amountInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); amountInput.blur(); }
  });
  noteInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); noteInput.blur(); }
  });

  // ---------- 状态 ----------
  const current = () => ({
    kind: state.kind, amountText: amountInput.value, categoryId: state.categoryId,
    date: dateInput.value, note: noteInput.value,
  });
  const isDirty = () => {
    const c = current();
    return Object.keys(initial).some((k) => c[k] !== initial[k]);
  };

  let confirming = false;
  async function onDismissRequest(close) {
    if (saving || confirming) return;
    if (!isDirty()) { close(); return; }
    confirming = true;
    try {
      const choice = await actionSheet({
        title: '放弃这次修改？',
        actions: [{ label: '放弃修改', style: 'destructive' }, { label: '取消', style: 'cancel' }],
      });
      if (choice === '放弃修改') close();
    } finally {
      confirming = false;
    }
  }

  async function save() {
    if (saving) return;
    clearAllErrors();
    const c = current();
    const bad = checkFields(c);
    if (bad) { showError(bad.field, bad.message); return; }
    saving = true;
    sheet.rightButton.disabled = true;
    try {
      await store.saveTransaction({
        id, kind: c.kind, amountMinor: parseAmount(c.amountText), categoryId: c.categoryId,
        occurredOn: c.date, note: c.note,
      });
      sheet.close();
    } catch (e) {
      const missing = !!c.categoryId && !store.categoryById(c.categoryId);
      const msg = e instanceof ValidationError ? messageFor(e.field, c, missing) : null;
      if (msg) showError(e.field, msg);
      else {
        console.error(e);
        messageDialog({ title: '储存失败', message: '请稍后再试一次。' });
      }
    } finally {
      saving = false;
      sheet.rightButton.disabled = false;
    }
  }

  async function confirmDelete() {
    if (saving || confirming) return;
    confirming = true;
    let choice;
    try {
      choice = await actionSheet({
        title: '删除这笔纪录？',
        actions: [{ label: '删除', style: 'destructive' }, { label: '取消', style: 'cancel' }],
      });
    } finally {
      confirming = false;
    }
    if (choice !== '删除') return;
    saving = true;
    try {
      await store.deleteTransaction(id);
    } catch (e) {
      console.error(e);
      saving = false;
      messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
      return;
    }
    sheet.close();
    // sheet 关闭后才显示（浮层下的 toast 会被设为 inert）
    showToast('已删除', {
      actionLabel: '撤销',
      onAction: () => {
        store.restoreTransaction(id).catch((e) => {
          console.error(e);
          messageDialog({ title: '撤销失败', message: '这笔纪录没能还原，请稍后再试。' });
        });
      },
    });
  }

  // ---------- 打开 ----------
  // 分类在 sheet 开着时有变动（例如 Task 12 新增分类）→ 重画网格
  const unsubscribe = store.subscribe(() => renderGrid());
  syncSegments();
  renderGrid();

  const sheet = openSheet({
    title: tx ? '编辑' : '记一笔',
    content,
    leftAction: { label: '取消', onClick: () => sheet.requestDismiss() },
    rightAction: { label: '储存', bold: true, onClick: () => { save(); } },
    onDismissRequest,
    onClosed: () => unsubscribe(),
  });
  // 必须同步（不能在 await 之后），iOS 才会弹出键盘
  amountInput.focus({ preventScroll: true });
  if (tx) amountInput.select();

  return { close: sheet.close };
}
