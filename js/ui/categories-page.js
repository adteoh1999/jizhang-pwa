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
import { icon, CATEGORY_ICON_CHOICES, ICON_LABELS } from './icons.js';
import { pushLayer } from './nav.js';
import { openSheet } from './sheet.js';
import { actionSheet, messageDialog, trapFocus } from './dialogs.js';
import { kindSegmented, confirmDiscard } from './components.js';
import { ValidationError, CATEGORY_NAME_MAX } from '../model.js';

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
 * openCategoryEditor(store, { kind, category?, onSaved?, onClosed? })
 * onSaved(rec)：储存成功、sheet 关闭后呼叫。onClosed()：任何途径关闭后呼叫（焦点已尝试还原给开启者之后）。
 */
export function openCategoryEditor(store, { kind, category, onSaved, onClosed } = {}) {
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
      if (await confirmDiscard()) close();
    } finally {
      confirming = false;
    }
  }

  async function save() {
    if (saving || confirming) return;
    clearNameError();
    // 编辑时没有实际变动 → 直接关闭，不写入（不改动默认分类的 updated_at / dirty）
    if (cat && nameInput.value.trim() === initial.name && iconSel === initial.icon) { sheet.close(); return; }
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
    onClosed,
  });
  // 必须同步（不能在 await 之后），iOS 才会弹出键盘
  nameInput.focus({ preventScroll: true });
  return { close: sheet.close };
}

/**
 * openCategoriesPage(store, { kind?, from?, onPicked?, restoreFocus? }) → { close }
 * kind：一开始显示的类型（预设 'expense'）。
 * from：'settings'（预设，返回键「‹ 设置」）或 'entry'（叠在记一笔上，返回键「‹ 返回」）。
 * onPicked(category)：有给时，新增分类成功后关闭子画面并呼叫它（记一笔用来选中新分类）。
 * restoreFocus()：关闭时开启者（例如记一笔的「＋ 新增」格）已因重画离开 DOM，改由它放回焦点。
 */
export function openCategoriesPage(store, {
  kind = 'expense', from = 'settings', onPicked, restoreFocus,
} = {}) {
  const opener = document.activeElement;
  const uid = `catpage-${++seq}`;
  let curKind = kind === 'income' ? 'income' : 'expense';

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
  const seg = kindSegmented({
    value: curKind,
    onChange: (k) => { curKind = k; renderList(); },
  });

  // ---------- 清单 ----------
  // 列按分类 id 重用（只更新名称 / 图示），编辑 sheet 的开启者（列按钮）才会一直留在 DOM，关闭后焦点能还原。
  const list = h('ul', { class: 'inset-group cat-list', role: 'list', 'aria-label': '分类' });
  const rows = new Map(); // id → { li, main, del, iconEl, nameEl, cat, sig }

  // 编辑 sheet 关闭后：开启者已不在（那列被删掉）→ 焦点放到「新增分类」，不掉到 body
  function afterEditorClosed() {
    if (!closed && !page.contains(document.activeElement)) addMain.focus({ preventScroll: true });
  }

  function buildRow(c) {
    const rec = { cat: c, sig: '' };
    rec.iconEl = h('span', { class: 'home-row-icon' });
    rec.nameEl = h('span', { class: 'cat-row-name' });
    rec.main = h('button', {
      type: 'button', class: 'cat-row-main',
      on: { click: () => openCategoryEditor(store, { category: rec.cat, onClosed: afterEditorClosed }) }, // 同步呼叫
    },
    rec.iconEl, rec.nameEl,
    h('span', { class: 'cat-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16)));
    rec.del = h('button', {
      type: 'button', class: 'cat-row-delete',
      on: { click: () => { confirmDeleteCategory(store, rec.cat); } },
    }, '删除');
    rec.li = h('li', { class: 'cat-row', 'data-id': c.id }, rec.main, rec.del);
    return rec;
  }

  function fillRow(rec, c) {
    rec.cat = c;
    const sig = `${c.name}\u0001${c.icon}`;
    if (sig === rec.sig) return;
    rec.sig = sig;
    rec.iconEl.dataset.icon = c.icon;
    rec.iconEl.replaceChildren(icon(c.icon, 20));
    rec.nameEl.textContent = c.name;
    rec.del.setAttribute('aria-label', `删除 ${c.name}`);
  }

  const addMain = h('button', {
    type: 'button', class: 'cat-row-main',
    on: {
      click: () => openCategoryEditor(store, { kind: curKind, onSaved: onCreated }), // 同步呼叫
    },
  },
  h('span', { class: 'cat-row-plus', 'aria-hidden': 'true' }, icon('plus', 20)),
  h('span', { class: 'cat-row-name' }, '新增分类'));
  const addRow = h('li', { class: 'cat-row cat-row-add' }, addMain);

  function renderList() {
    const hadFocus = list.contains(document.activeElement) ? document.activeElement : null;
    const wanted = [];
    const seen = new Set();
    for (const c of store.categories(curKind)) {
      let rec = rows.get(c.id);
      if (!rec) { rec = buildRow(c); rows.set(c.id, rec); }
      fillRow(rec, c);
      seen.add(c.id);
      wanted.push(rec.li);
    }
    wanted.push(addRow);
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    // 顺序没变就不搬动节点（搬动会让焦点掉到 body）
    const same = wanted.length === list.children.length && wanted.every((el, i) => list.children[i] === el);
    if (!same) list.replaceChildren(...wanted);
    if (hadFocus && document.activeElement !== hadFocus) {
      // 原本的按钮还在 → 放回去；那列被删掉 → 焦点放到「新增分类」，不掉回页首
      (list.contains(hadFocus) ? hadFocus : addMain).focus({ preventScroll: true });
    }
  }

  function onCreated(rec) {
    if (!onPicked) return;
    close();
    onPicked(rec);
  }

  const body = h('div', { class: 'nav-page-body' },
    seg.element, list,
    h('p', { class: 'settings-footer' }, '点一下分类可以改名、换图示或删除。'));
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
      } else if (restoreFocus) {
        restoreFocus();
      }
    },
  });
  function close() { handle.close(); }

  renderList();
  document.body.append(page);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) page.classList.add('is-visible'); }));
  return { close };
}
