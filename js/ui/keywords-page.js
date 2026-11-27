// 关键词管理子画面（3e）：设置 › 关键词。Telegram bot 记账时，文字、截图说明或店名含关键词，就一定记成那个分类。
// 版面沿用分类管理页（nav-page、inset-group 列）；编辑 sheet 沿用记一笔的分类格（只用 CSS 类，DOM 自己建）。
// 用户 2026-11-27 决定：清单 L1（一张清单、按关键词排序）；只用在 Telegram bot；收支相同才套用；英文／数字要整个词。
import { h } from './dom.js';
import { icon, iconKey } from './icons.js';
import { pushLayer } from './nav.js';
import { openSheet } from './sheet.js';
import { actionSheet, messageDialog, trapFocus } from './dialogs.js';
import { kindSegmented, confirmDiscard } from './components.js';
import { ValidationError, KEYWORD_LIMIT, KEYWORD_MAX, normalizeKeyword } from '../model.js';

let seq = 0;

export const KEYWORD_HELP = '备注或店名含这几个字（不分大小写），就记成下面的分类。英文要整个词才算，例如 grab 不包括 grabfood。'
  + 'AI 认成的收入／支出跟这个分类不同时，不会套用。';
const GONE_NOTICE = '原本的分类已删除，请重新选';

/** 清单列（纯函数）：分类不存在或已删除 → gone（红字「分类已删除」，bot 也不会用它）。 */
export function keywordRows(keywords, categoryById) {
  return keywords.map((k) => {
    const c = categoryById(k.category_id);
    const ok = !!c && !c.deleted;
    return {
      keyword: k.keyword,
      catName: ok ? c.name : null,
      iconKey: ok ? iconKey(c.icon) : null,
      gone: !ok,
      label: ok ? `${k.keyword}，分类 ${c.name}` : `${k.keyword}，分类已删除`,
    };
  });
}

/** 错误文字（纯函数）。code：checkKeyword 的原因或 'category'。 */
export function keywordErrorText(code, { dupCategoryName } = {}) {
  switch (code) {
    case 'empty': return '请输入关键词';
    case 'long': return `关键词最多 ${KEYWORD_MAX} 字`;
    case 'bad': return '关键词不能有特殊控制字元';
    case 'dup': return dupCategoryName ? `已经有这个关键词（→ ${dupCategoryName}）` : '已经有这个关键词';
    case 'limit': return `最多 ${KEYWORD_LIMIT} 个关键词`;
    case 'category': return '请选一个分类';
    default: return '储存不了，请再试一次';
  }
}

/** 编辑 sheet 的起始状态（纯函数）。分类已删除：分段停在原分类的收支（不知道就支出）、不选分类、提示重新选。 */
export function keywordEditorStart(rec, categoryById) {
  if (!rec) return { keyword: '', kind: 'expense', categoryId: null, notice: null };
  const c = categoryById(rec.category_id);
  if (c && !c.deleted) return { keyword: rec.keyword, kind: c.kind, categoryId: c.id, notice: null };
  return { keyword: rec.keyword, kind: c && c.kind === 'income' ? 'income' : 'expense', categoryId: null, notice: GONE_NOTICE };
}

/** 「储存」能不能按（纯函数）：有选分类、关键词不是空白、而且跟一开始不同（大小写与头尾空白不算不同）。 */
export function keywordSaveEnabled(cur, start) {
  const k = normalizeKeyword(cur.keyword);
  if (k === '' || !cur.categoryId) return false;
  return k !== normalizeKeyword(start.keyword) || cur.categoryId !== start.categoryId;
}

/** 设置页「关键词」列右边：0 个不显示数字。 */
export const keywordCountDetail = (n) => (n > 0 ? `${n} 个` : '');

/**
 * 新增 / 编辑关键词的 sheet。必须在点击事件里同步呼叫（输入框 focus 才会弹出键盘）。
 * openKeywordEditor(store, { keyword?（编辑的那一列）, onClosed? })
 */
export function openKeywordEditor(store, { keyword: rec = null, onClosed } = {}) {
  const uid = `kwed-${++seq}`;
  const byId = (id) => store.categoryById(id);
  const start = keywordEditorStart(rec, byId);
  let kind = start.kind;
  let categoryId = start.categoryId;
  let saving = false;
  let confirming = false;

  // ---------- 关键词 ----------
  const input = h('input', {
    class: 'entry-input kw-input', id: `${uid}-kw`, type: 'text', placeholder: '例如 grab、猫粮',
    autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
    'aria-labelledby': `${uid}-kw-label`, 'aria-describedby': `${uid}-kw-help`,
  });
  input.value = start.keyword;
  const kwError = h('p', { class: 'field-error', id: `${uid}-kw-err`, role: 'alert', hidden: true });
  const kwRow = h('div', { class: 'entry-row' }, input);
  const kwField = h('div', { class: 'entry-section' },
    h('h3', { class: 'entry-section-label', id: `${uid}-kw-label` }, '关键词'),
    h('div', { class: 'entry-card entry-list' }, kwRow),
    kwError,
    h('p', { class: 'settings-footer kw-help', id: `${uid}-kw-help` }, KEYWORD_HELP));

  function clearError() {
    if (kwError.hidden) return;
    kwError.hidden = true;
    kwError.textContent = '';
    input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', `${uid}-kw-help`);
  }
  function showError(message, { focusInput = true } = {}) {
    kwError.textContent = message;
    kwError.hidden = false; // role=alert：读屏会念
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', `${kwError.id} ${uid}-kw-help`);
    kwRow.classList.remove('is-shaking');
    void kwRow.offsetWidth;
    kwRow.classList.add('is-shaking');
    setTimeout(() => kwRow.classList.remove('is-shaking'), 500);
    if (focusInput) input.focus({ preventScroll: false });
  }
  input.addEventListener('input', () => { clearError(); updateSave(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 输入法组字中
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  // ---------- 支出 / 收入＋分类格 ----------
  const seg = kindSegmented({
    value: kind,
    onChange: (k) => { kind = k; categoryId = null; notice.hidden = true; renderGrid(); updateSave(); },
  });
  const notice = h('p', { class: 'field-error kw-notice', role: 'status', hidden: !start.notice }, start.notice || '');
  const grid = h('div', { class: 'cat-grid', role: 'group', 'aria-labelledby': `${uid}-cat-label` });
  function renderGrid() {
    const hadFocus = grid.contains(document.activeElement) ? document.activeElement.dataset.cat : null;
    grid.replaceChildren(...store.categories(kind).map((c) => h('button', {
      type: 'button', class: 'cat-tile', 'data-cat': c.id, 'data-icon': iconKey(c.icon),
      'aria-pressed': c.id === categoryId ? 'true' : 'false', 'aria-label': c.name,
      on: { click: () => { categoryId = c.id; notice.hidden = true; clearError(); renderGrid(); updateSave(); } },
    },
    h('span', { class: 'cat-tile-icon' }, icon(c.icon, 22)),
    h('span', { class: 'cat-tile-name' }, c.name))));
    if (hadFocus) {
      const again = grid.querySelector(`[data-cat="${CSS.escape(hadFocus)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }
  renderGrid();
  const catField = h('div', { class: 'entry-section' },
    h('h3', { class: 'entry-section-label', id: `${uid}-cat-label` }, '分类'),
    notice,
    h('div', { class: 'entry-card cat-card' }, grid));

  // ---------- 删除（编辑时） ----------
  const deleteButton = rec
    ? h('button', { type: 'button', class: 'entry-delete', on: { click: () => onDelete() } }, '删除关键词')
    : null;

  const content = h('div', { class: 'entry' },
    kwField, h('div', { class: 'entry-section' }, seg.element), catField,
    deleteButton ? h('div', { class: 'entry-section' }, deleteButton) : null);

  // ---------- 动作 ----------
  const current = () => ({ keyword: input.value, categoryId });
  const isDirty = () => normalizeKeyword(input.value) !== normalizeKeyword(start.keyword) || categoryId !== start.categoryId;
  function updateSave() {
    if (!saving) sheet.rightButton.disabled = !keywordSaveEnabled(current(), start);
  }

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
    if (saving || confirming || !keywordSaveEnabled(current(), start)) return;
    clearError();
    saving = true;
    sheet.rightButton.disabled = true;
    try {
      await store.saveKeyword({ keyword: input.value, categoryId, previous: rec ? rec.keyword : null });
    } catch (e) {
      saving = false;
      updateSave();
      if (e instanceof ValidationError && e.field.startsWith('keyword-')) {
        const code = e.field.slice('keyword-'.length);
        const dup = code === 'dup' ? store.keywords().find((k) => k.keyword === normalizeKeyword(input.value)) : null;
        const dupCat = dup ? byId(dup.category_id) : null;
        showError(keywordErrorText(code, { dupCategoryName: dupCat && !dupCat.deleted ? dupCat.name : null }));
      } else if (e instanceof ValidationError && e.field === 'category') {
        categoryId = null;
        renderGrid();
        updateSave();
        showError(keywordErrorText('category'), { focusInput: false });
      } else {
        console.error(e);
        messageDialog({ title: '储存失败', message: '请稍后再试一次。' });
      }
      return;
    }
    sheet.close();
  }

  async function onDelete() {
    if (saving || confirming) return;
    confirming = true;
    let deleted = false;
    try {
      const choice = await actionSheet({
        title: '删除关键词？',
        message: `之后 Telegram 记账不会再用「${rec.keyword}」决定分类，旧的记录不会改`,
        actions: [{ label: '删除', style: 'destructive' }, { label: '取消', style: 'cancel' }],
      });
      if (choice === '删除') {
        try {
          await store.deleteKeyword(rec.keyword);
          deleted = true;
        } catch (e) {
          console.error(e);
          messageDialog({ title: '删除失败', message: '请稍后再试一次。' });
        }
      }
    } finally {
      confirming = false;
    }
    if (deleted) sheet.close();
  }

  const sheet = openSheet({
    title: rec ? '编辑关键词' : '新增关键词',
    content,
    leftAction: { label: '取消', onClick: () => sheet.requestDismiss() },
    rightAction: { label: '储存', bold: true, onClick: () => { save(); } },
    onDismissRequest,
    onClosed,
  });
  updateSave();
  // 必须同步（不能在 await 之后），iOS 才会弹出键盘；编辑时不弹（多半是改分类）
  if (!rec) input.focus({ preventScroll: true });
  return { close: sheet.close };
}

/** openKeywordsPage(store) → { close }：从设置页打开，返回键「‹ 设置」。 */
export function openKeywordsPage(store) {
  const opener = document.activeElement;
  const uid = `kwpage-${++seq}`;

  // ---------- 导航列 ----------
  const backBtn = h('button', { type: 'button', class: 'nav-back', on: { click: () => close() } },
    h('span', { class: 'nav-back-chevron', 'aria-hidden': 'true' }, icon('chevron-left', 22)),
    h('span', null, '设置'));
  const bar = h('header', { class: 'nav-page-bar' },
    backBtn,
    h('h2', { class: 'nav-page-title', id: `${uid}-title` }, '关键词'),
    h('span', { 'aria-hidden': 'true' }));

  // ---------- 新增（独立一组，在最上面） ----------
  const addMain = h('button', {
    type: 'button', class: 'cat-row-main',
    on: { click: () => openKeywordEditor(store, { onClosed: afterEditorClosed }) },
  },
  h('span', { class: 'cat-row-plus', 'aria-hidden': 'true' }, icon('plus', 20)),
  h('span', { class: 'cat-row-name' }, '新增关键词'));
  const addGroup = h('ul', { class: 'inset-group cat-list kw-add', role: 'list' }, h('li', { class: 'cat-row cat-row-add' }, addMain));
  const limitNote = h('p', { class: 'settings-footer', hidden: true }, `最多 ${KEYWORD_LIMIT} 个关键词，删掉一些才能再加。`);

  // ---------- 清单 ----------
  const list = h('ul', { class: 'inset-group cat-list kw-list', role: 'list', 'aria-label': '关键词' });
  const empty = h('div', { class: 'kw-empty', hidden: true },
    h('p', { class: 'kw-empty-title' }, '还没有关键词'),
    h('p', { class: 'kw-empty-text' }, '例如加「grab → 交通」，之后在 Telegram 传「Grab 12.50」或 Grab 的付款截图，就一定记成交通。'));
  const footer = h('p', { class: 'settings-footer' },
    '备注或店名含关键词（不分大小写），bot 就一定记成那个分类，不管 AI 怎么认。两个都对上时，用比较长的那个。');
  const rows = new Map(); // keyword → { li, main, sig }

  // 编辑 sheet 关闭后：开启者已不在（那列被删掉）→ 焦点放到「新增关键词」
  function afterEditorClosed() {
    if (!closed && !page.contains(document.activeElement)) addMain.focus({ preventScroll: true });
  }

  function renderList() {
    const kws = store.keywords();
    const full = kws.length >= KEYWORD_LIMIT;
    addMain.disabled = full;
    limitNote.hidden = !full;
    empty.hidden = kws.length > 0;
    list.hidden = kws.length === 0;
    footer.hidden = kws.length === 0;
    const hadFocus = list.contains(document.activeElement) ? document.activeElement : null;
    const wanted = [];
    const seen = new Set();
    const view = keywordRows(kws, (id) => store.categoryById(id));
    kws.forEach((k, i) => {
      const v = view[i];
      let rec = rows.get(k.keyword);
      if (!rec) {
        rec = { li: null, main: null, sig: '', kw: k };
        rec.main = h('button', {
          type: 'button', class: 'cat-row-main kw-row-main',
          on: { click: () => openKeywordEditor(store, { keyword: rec.kw, onClosed: afterEditorClosed }) },
        });
        rec.li = h('li', { class: 'cat-row', 'data-keyword': k.keyword }, rec.main);
        rows.set(k.keyword, rec);
      }
      rec.kw = k;
      const sig = `${v.catName}\u0001${v.iconKey}\u0001${v.gone}`;
      if (sig !== rec.sig) {
        rec.sig = sig;
        rec.main.setAttribute('aria-label', v.label);
        rec.main.replaceChildren(
          h('span', { class: 'kw-row-name', 'aria-hidden': 'true' }, k.keyword),
          v.gone
            ? h('span', { class: 'kw-cat is-gone', 'aria-hidden': 'true' }, '分类已删除')
            : h('span', { class: 'kw-cat', 'aria-hidden': 'true' },
              h('span', { class: 'kw-cat-icon' }, icon(v.iconKey, 16)), h('span', { class: 'kw-cat-name' }, v.catName)),
          h('span', { class: 'cat-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', 16)));
      }
      seen.add(k.keyword);
      wanted.push(rec.li);
    });
    for (const key of [...rows.keys()]) if (!seen.has(key)) rows.delete(key);
    const same = wanted.length === list.children.length && wanted.every((el, i) => list.children[i] === el);
    if (!same) list.replaceChildren(...wanted);
    if (hadFocus && document.activeElement !== hadFocus) {
      (list.contains(hadFocus) ? hadFocus : addMain).focus({ preventScroll: true });
    }
  }

  const body = h('div', { class: 'nav-page-body' }, addGroup, limitNote, list, empty, footer);
  const page = h('div', {
    class: 'nav-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title`,
  }, bar, body);
  trapFocus(page, page);

  // ---------- 入栈 ----------
  let closed = false;
  const unsubscribe = store.subscribe(() => renderList());
  const handle = pushLayer({
    element: page,
    onClose: () => {
      closed = true;
      unsubscribe();
      page.classList.remove('is-visible');
      const remove = () => page.remove();
      page.addEventListener('transitionend', (e) => { if (e.target === page) remove(); });
      setTimeout(remove, 450); // 后备
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
    },
  });
  function close() { handle.close(); }

  renderList();
  document.body.append(page);
  backBtn.focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!closed) page.classList.add('is-visible'); }));
  return { close };
}
