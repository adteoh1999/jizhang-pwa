// 分类管理子画面（iOS 导航推入：从右边滑入，左上「‹ 设置」/「‹ 返回」）＋ 新增 / 编辑分类的 sheet。
// 可以从设置页打开，也可以叠在记一笔的 sheet 上打开（从「＋ 新增」）：
// 那时新增成功后，子画面自动关闭并呼叫 onPicked(新分类)，记一笔就选中它。
//
// 删除路径：没有左滑。首页的左滑状态机和首页的渲染循环（拖动计数、延后重画、文件层后备收尾、
// 捲动关闭）绑得很紧，抽成共用模组风险高；这里改为：
// 1) 编辑 sheet 底部的红色「删除分类」；
// 2) 每列后面一直在 DOM 里的「删除」按钮（平常隐藏，键盘 Tab / VoiceOver 聚焦时显示）。
// 两条路都先用 action sheet 确认。
import { h } from './dom.js';
import { icon, CATEGORY_ICON_CHOICES } from './icons.js';
import { pushLayer } from './nav.js';
import { openSheet } from './sheet.js';
import { actionSheet, messageDialog, trapFocus } from './dialogs.js';
import { ValidationError, CATEGORY_NAME_MAX } from '../model.js';

const KINDS = [
  { id: 'expense', label: '支出' },
  { id: 'income', label: '收入' },
];

// 图示的中文名称（VoiceOver 用）
const ICON_LABELS = {
  food: '餐饮', transport: '交通', shopping: '购物', bills: '账单', fun: '娱乐', other: '其他',
  salary: '工资', bonus: '奖金', side: '副业', other_income: '其他收入',
  pet: '宠物', health: '医疗', home: '居家', gift: '礼物', travel: '旅行', education: '教育',
  coffee: '咖啡', phone: '手机',
};

let seq = 0;

/**
 * 分类名称检查（与 model.buildCategory 一样先去掉前后空白）。
 * sameKind：同类型的活动分类；selfId：编辑中的分类 id（新增时为 null）。
 * 回传中文错误讯息，或 null（可以储存）。
 */
export function checkCategoryName(name, sameKind, selfId) {
  const n = String(name ?? '').trim();
  if (n.length === 0) return '请输入名称';
  if (n.length > CATEGORY_NAME_MAX) return `名称最多 ${CATEGORY_NAME_MAX} 字`;
  if (sameKind.some((c) => c.id !== selfId && c.name === n)) return '已经有这个分类';
  return null;
}

/** 删除确认（action sheet）→ 删除。回传是否已删除。 */
async function confirmDeleteCategory(store, cat) {
  const choice = await actionSheet({
    title: '删除分类？',
    message: '删除后，旧的记录仍保留这个分类名称',
    actions: [{ label: '删除', style: 'destructive' }, { label: '取消', style: 'cancel' }],
  });
  if (choice !== '删除') return false;
  try {
    await store.deleteCategory(cat.id);
    return true;
  } catch (e) {
    console.error(e);
    messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
    return false;
  }
}

/**
 * 新增 / 编辑分类的 sheet。必须在点击事件里同步呼叫（名称框 focus 才会弹出键盘）。
 * openCategoryEditor(store, { kind, category?, onSaved? })；onSaved(rec) 在储存成功、sheet 关闭后呼叫。
 */
export function openCategoryEditor(store, { kind, category, onSaved } = {}) {
  const cat = category || null;
  const catKind = cat ? cat.kind : kind;
  const uid = `cated-${++seq}`;
  const initial = {
    name: cat ? cat.name : '',
    icon: cat ? cat.icon : (catKind === 'income' ? 'other_income' : 'other'),
  };
  let iconSel = initial.icon;
  let saving = false;
  let confirming = false;

  // ---------- 名称 ----------
  const nameInput = h('input', {
    class: 'entry-input cat-name-input', id: `${uid}-name`, type: 'text',
    placeholder: '名称', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': '名称',
  });
  nameInput.value = initial.name;
  const nameError = h('p', { class: 'field-error', id: `${uid}-name-err`, role: 'alert', hidden: true });
  const nameRow = h('div', { class: 'entry-row' }, nameInput);
  const nameField = h('div', { class: 'entry-section' },
    h('div', { class: 'entry-card entry-list' }, nameRow), nameError);

  function clearNameError() {
    if (nameError.hidden) return;
    nameError.hidden = true;
    nameError.textContent = '';
    nameInput.removeAttribute('aria-invalid');
    nameInput.removeAttribute('aria-describedby');
  }
  function showNameError(message) {
    nameError.textContent = message;
    nameError.hidden = false; // role=alert：VoiceOver 会读出
    nameInput.setAttribute('aria-invalid', 'true');
    nameInput.setAttribute('aria-describedby', nameError.id);
    nameRow.classList.remove('is-shaking');
    void nameRow.offsetWidth; // 重新触发动画
    nameRow.classList.add('is-shaking');
    setTimeout(() => nameRow.classList.remove('is-shaking'), 500);
    nameInput.focus({ preventScroll: false });
  }
  nameInput.addEventListener('input', clearNameError);
  nameInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
    if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
  });

  // ---------- 图示 ----------
  const iconGrid = h('div', { class: 'cat-grid icon-grid', role: 'group', 'aria-labelledby': `${uid}-icon-label` });
  function renderIcons() {
    const hadFocus = iconGrid.contains(document.activeElement) ? document.activeElement.dataset.icon : null;
    iconGrid.replaceChildren(...CATEGORY_ICON_CHOICES.map((name) => h('button', {
      type: 'button', class: 'cat-tile', 'data-icon': name,
      'aria-pressed': name === iconSel ? 'true' : 'false', 'aria-label': ICON_LABELS[name] || name,
      on: { click: () => { iconSel = name; renderIcons(); } },
    }, h('span', { class: 'cat-tile-icon' }, icon(name, 22)))));
    if (hadFocus) {
      const again = iconGrid.querySelector(`[data-icon="${hadFocus}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }
  renderIcons();
  const iconField = h('div', { class: 'entry-section' },
    h('h3', { class: 'entry-section-label', id: `${uid}-icon-label` }, '图示'),
    h('div', { class: 'entry-card cat-card' }, iconGrid));

  // ---------- 删除（编辑模式） ----------
  const deleteButton = cat
    ? h('button', { type: 'button', class: 'entry-delete', on: { click: () => onDelete() } }, '删除分类')
    : null;

  const content = h('div', { class: 'entry' },
    nameField, iconField,
    deleteButton ? h('div', { class: 'entry-section' }, deleteButton) : null);

  // ---------- 动作 ----------
  const isDirty = () => nameInput.value !== initial.name || iconSel !== initial.icon;

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
    if (saving || confirming) return;
    clearNameError();
    const bad = checkCategoryName(nameInput.value, store.categories(catKind), cat ? cat.id : null);
    if (bad) { showNameError(bad); return; }
    saving = true;
    sheet.rightButton.disabled = true;
    let rec;
    try {
      rec = await store.saveCategory(cat
        ? { id: cat.id, kind: catKind, name: nameInput.value, icon: iconSel }
        : { kind: catKind, name: nameInput.value, icon: iconSel });
    } catch (e) {
      saving = false;
      sheet.rightButton.disabled = false;
      if (e instanceof ValidationError && e.field === 'name') {
        showNameError(checkCategoryName(nameInput.value, [], null) || '请输入名称');
      } else {
        console.error(e);
        messageDialog({ title: '储存失败', message: '请稍后再试一次。' });
      }
      return;
    }
    sheet.close();
    if (onSaved) onSaved(rec);
  }

  async function onDelete() {
    if (saving || confirming) return;
    confirming = true;
    let deleted = false;
    try {
      deleted = await confirmDeleteCategory(store, cat);
    } finally {
      confirming = false;
    }
    if (deleted) sheet.close();
  }

  const sheet = openSheet({
    title: cat ? '编辑分类' : '新增分类',
    content,
    leftAction: { label: '取消', onClick: () => sheet.requestDismiss() },
    rightAction: { label: '储存', bold: true, onClick: () => { save(); } },
    onDismissRequest,
  });
  // 必须同步（不能在 await 之后），iOS 才会弹出键盘
  nameInput.focus({ preventScroll: true });
  return { close: sheet.close };
}

/**
 * openCategoriesPage(store, { kind?, from?, onPicked? }) → { close }
 * kind：一开始显示的类型（预设 'expense'）。
 * from：'settings'（预设，返回键「‹ 设置」）或 'entry'（叠在记一笔上，返回键「‹ 返回」）。
 * onPicked(category)：有给时，新增分类成功后关闭子画面并呼叫它（记一笔用来选中新分类）。
 */
export function openCategoriesPage(store, { kind = 'expense', from = 'settings', onPicked } = {}) {
  const opener = document.activeElement;
  const uid = `catpage-${++seq}`;
  let curKind = KINDS.some((k) => k.id === kind) ? kind : 'expense';

  // ---------- 导航列 ----------
  const backBtn = h('button', {
    type: 'button', class: 'nav-back', on: { click: () => close() },
  },
  h('span', { class: 'nav-back-chevron', 'aria-hidden': 'true' }, icon('chevron-left', 22)),
  h('span', null, from === 'entry' ? '返回' : '设置'));
  const bar = h('header', { class: 'nav-page-bar' },
    backBtn,
    h('h2', { class: 'nav-page-title', id: `${uid}-title` }, '分类'),
    h('span', { 'aria-hidden': 'true' }));

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
        const next = curKind === 'expense' ? 'income' : 'expense';
        setKind(next);
        segButtons.find((b) => b.dataset.kind === next).focus();
      },
    },
  }, segButtons);
  function syncSegments() {
    for (const b of segButtons) {
      const on = b.dataset.kind === curKind;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    segmented.dataset.selected = curKind;
  }
  function setKind(k) {
    if (k === curKind) return;
    curKind = k;
    syncSegments();
    renderList();
  }

  // ---------- 清单 ----------
  const list = h('ul', { class: 'inset-group cat-list', role: 'list', 'aria-label': '分类' });

  function row(c) {
    return h('li', { class: 'cat-row', 'data-id': c.id },
      h('button', {
        type: 'button', class: 'cat-row-main', 'data-focus': `main:${c.id}`,
        on: { click: () => openCategoryEditor(store, { category: c }) }, // 同步呼叫
      },
      h('span', { class: 'home-row-icon' }, icon(c.icon, 20)),
      h('span', { class: 'cat-row-name' }, c.name),
      h('span', { class: 'cat-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16))),
      h('button', {
        type: 'button', class: 'cat-row-delete', 'data-focus': `del:${c.id}`, 'aria-label': `删除 ${c.name}`,
        on: { click: () => { confirmDeleteCategory(store, c); } },
      }, '删除'));
  }

  const addRow = h('li', { class: 'cat-row cat-row-add' },
    h('button', {
      type: 'button', class: 'cat-row-main', 'data-focus': 'add',
      on: {
        click: () => openCategoryEditor(store, { kind: curKind, onSaved: onCreated }), // 同步呼叫
      },
    },
    h('span', { class: 'cat-row-plus', 'aria-hidden': 'true' }, icon('plus', 20)),
    h('span', { class: 'cat-row-name' }, '新增分类')));

  function renderList() {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    const cats = store.categories(curKind);
    list.replaceChildren(...cats.map(row), addRow);
    if (focused && !list.contains(document.activeElement)) {
      const again = list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)
        || (focused.startsWith('del:') ? list.querySelector(`[data-focus="main:${CSS.escape(focused.slice(4))}"]`) : null)
        || addRow.firstChild; // 那列被删掉 → 焦点放到「新增分类」，不掉回页首
      again.focus({ preventScroll: true });
    }
  }

  function onCreated(rec) {
    if (!onPicked) return;
    close();
    onPicked(rec);
  }

  const body = h('div', { class: 'nav-page-body' },
    segmented, list,
    h('p', { class: 'settings-footer' }, '点一下分类可以改名、换图示。'));
  const page = h('div', {
    class: 'nav-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title`,
  }, bar, body);
  trapFocus(page, page);

  // ---------- 入栈 ----------
  let closed = false;
  const unsubscribe = store.subscribe(() => renderList());
  const handle = pushLayer({
    element: page, // 上面再开 sheet / action sheet 时自动 inert
    onClose: () => {
      closed = true;
      unsubscribe();
      page.classList.remove('is-visible');
      const remove = () => page.remove();
      page.addEventListener('transitionend', (e) => { if (e.target === page) remove(); });
      setTimeout(remove, 450); // 后备
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    },
  });
  function close() { handle.close(); }

  syncSegments();
  renderList();
  document.body.append(page);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) page.classList.add('is-visible'); }));
  return { close };
}
