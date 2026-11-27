// 3e 设置页关键词画面：纯函数（清单列、错误文字、编辑起始状态、储存键、设置列）＋接线检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  keywordRows, keywordErrorText, keywordEditorStart, keywordSaveEnabled, keywordCountDetail, KEYWORD_HELP,
  keywordsFooter, keywordErrorTarget, categoryAfterKindSwitch, focusAfterEdit,
} from '../js/ui/keywords-page.js';
import { css, blockAfter } from './helpers/css-tokens.js';
import { deleteCategoryMessage } from '../js/ui/categories-page.js';

const CATS = {
  transport: { id: 'transport', kind: 'expense', name: '交通', icon: 'transport', deleted: false },
  food: { id: 'food', kind: 'expense', name: '餐饮', icon: 'food', deleted: false },
  gym: { id: 'gym', kind: 'expense', name: '健身', icon: 'other', deleted: true },
  salary: { id: 'salary', kind: 'income', name: '工资', icon: 'salary', deleted: false },
};
const byId = (id) => CATS[id];
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('keywordRows：分类名与图示；分类已删除或不存在 → gone；读屏念「grab，分类 交通」', () => {
  const rows = keywordRows([
    { keyword: 'grab', category_id: 'transport' },
    { keyword: '健身', category_id: 'gym' },
    { keyword: 'ghost', category_id: 'nope' },
  ], byId);
  assert.deepEqual(rows, [
    { keyword: 'grab', catName: '交通', iconKey: 'transport', gone: false, label: 'grab，分类 交通' },
    { keyword: '健身', catName: null, iconKey: null, gone: true, label: '健身，分类已删除' },
    { keyword: 'ghost', catName: null, iconKey: null, gone: true, label: 'ghost，分类已删除' },
  ]);
});

test('keywordErrorText：每个原因一句中文', () => {
  assert.equal(keywordErrorText('empty'), '请输入关键词');
  assert.equal(keywordErrorText('long'), '关键词最多 20 字');
  assert.equal(keywordErrorText('bad'), '关键词不能有特殊控制字元');
  assert.equal(keywordErrorText('dup', { dupCategoryName: '交通' }), '已经有这个关键词（→ 交通）');
  assert.equal(keywordErrorText('dup', {}), '已经有这个关键词');
  assert.equal(keywordErrorText('limit'), '最多 200 个关键词');
  assert.equal(keywordErrorText('category'), '请选一个分类');
});

test('keywordEditorStart：新增 → 支出、没选；编辑 → 分类的收支与分类；分类已删除 → 停在原收支、没选、提示重新选', () => {
  assert.deepEqual(keywordEditorStart(null, byId), { keyword: '', kind: 'expense', categoryId: null, notice: null });
  assert.deepEqual(keywordEditorStart({ keyword: '工资单', category_id: 'salary' }, byId),
    { keyword: '工资单', kind: 'income', categoryId: 'salary', notice: null });
  assert.deepEqual(keywordEditorStart({ keyword: '健身', category_id: 'gym' }, byId),
    { keyword: '健身', kind: 'expense', categoryId: null, notice: '原本的分类已删除，请重新选' });
  assert.deepEqual(keywordEditorStart({ keyword: 'ghost', category_id: 'nope' }, byId),
    { keyword: 'ghost', kind: 'expense', categoryId: null, notice: '原本的分类已删除，请重新选' });
});

test('keywordSaveEnabled：没改动或没选分类或空白 → 不能按', () => {
  const start = { keyword: 'grab', categoryId: 'transport' };
  assert.equal(keywordSaveEnabled({ keyword: 'grab', categoryId: 'transport' }, start), false);
  assert.equal(keywordSaveEnabled({ keyword: 'GRAB ', categoryId: 'transport' }, start), false, '只差大小写与空白也算没改');
  assert.equal(keywordSaveEnabled({ keyword: 'grab', categoryId: 'food' }, start), true);
  assert.equal(keywordSaveEnabled({ keyword: 'grabcar', categoryId: 'transport' }, start), true);
  assert.equal(keywordSaveEnabled({ keyword: '  ', categoryId: 'transport' }, start), false);
  assert.equal(keywordSaveEnabled({ keyword: 'grab', categoryId: null }, { keyword: '', categoryId: null }), false);
  assert.equal(keywordSaveEnabled({ keyword: 'grab', categoryId: 'food' }, { keyword: '', categoryId: null }), true);
});

test('keywordCountDetail：0 个不显示数字', () => {
  assert.equal(keywordCountDetail(0), '');
  assert.equal(keywordCountDetail(10), '10 个');
});

test('说明文字：英文要整个词、收支不同不套用', () => {
  assert.match(KEYWORD_HELP, /不分大小写/);
  assert.match(KEYWORD_HELP, /grab 不包括 grabfood/);
  assert.match(KEYWORD_HELP, /收入／支出跟这个分类不同时，不会套用/);
});

test('删除分类的确认文字：有关键词指向它 → 说会失效', () => {
  assert.equal(deleteCategoryMessage(0), '删除后，旧的记录仍保留这个分类名称');
  assert.equal(deleteCategoryMessage(2), '删除后，旧的记录仍保留这个分类名称。有 2 个关键词指向这个分类，会失效');
});

test('审核 M-15：组尾说明——Telegram 里不写「需要先连接 Telegram」（已经连了）', () => {
  assert.equal(keywordsFooter(false), '在 Telegram 记账时，备注或店名有你的关键词，就一定记成对应的分类（需要先连接 Telegram）。');
  assert.equal(keywordsFooter(true), '在 Telegram 记账时，备注或店名有你的关键词，就一定记成对应的分类。');
});

test('审核 M-10：「请选一个分类」显示在分类区，不放在关键词框下（读屏不会以为是关键词写错）', () => {
  assert.equal(keywordErrorTarget('category'), 'category');
  for (const c of ['empty', 'long', 'bad', 'dup', 'limit']) assert.equal(keywordErrorTarget(c), 'keyword');
});

test('审核 M-13：切换收支清掉分类；切回起始收支时还原起始分类', () => {
  const start = { kind: 'expense', categoryId: 'transport' };
  assert.equal(categoryAfterKindSwitch('income', start), null);
  assert.equal(categoryAfterKindSwitch('expense', start), 'transport');
  assert.equal(categoryAfterKindSwitch('expense', { kind: 'expense', categoryId: null }), null);
});

test('审核 M-11：编辑关闭后焦点——存了就放到那一列；没有那列就「新增」；「新增」停用（满 200）就返回键', () => {
  assert.equal(focusAfterEdit({ savedRowExists: true, addDisabled: true }), 'row');
  assert.equal(focusAfterEdit({ savedRowExists: false, addDisabled: false }), 'add');
  assert.equal(focusAfterEdit({ savedRowExists: false, addDisabled: true }), 'back');
});

test('审核 M-16：「分类已删除」不受 45% 宽度限制、不缩（320 宽大字级不压到箭头）', () => {
  const b = blockAfter(css, '\n.kw-cat.is-gone {');
  assert.match(b, /max-width:\s*none/);
  assert.match(b, /flex:\s*none/);
});

test('审核 M-12／M-14：满 200 的停用按钮关联说明；分类已删除提示关联到分类格（读屏会念）', () => {
  const k = src('js/ui/keywords-page.js');
  assert.match(k, /addMain\.setAttribute\('aria-describedby', limitNote\.id\)/);
  assert.match(k, /grid\.setAttribute\('aria-describedby', notice\.id\)/);
});

test('接线：设置页「分类」组有「关键词」列与组尾说明；sw.js 离线清单有 keywords-page.js', () => {
  const s = src('js/ui/settings.js');
  assert.match(s, /openKeywordsPage\(store\)/);
  assert.match(s, /'关键词'/);
  assert.match(s, /keywordsFooter\(!!telegram\)/);
  assert.match(src('sw.js'), /'\.\/js\/ui\/keywords-page\.js'/);
});

test('接线：关键词输入框关掉自动大写、自动更正、拼字检查；储存键依 keywordSaveEnabled 停用', () => {
  const k = src('js/ui/keywords-page.js');
  for (const a of ["autocapitalize: 'none'", "autocorrect: 'off'", "spellcheck: 'false'", "enterkeyhint: 'done'", "autocomplete: 'off'"]) {
    assert.ok(k.includes(a), a);
  }
  assert.match(k, /sheet\.rightButton\.disabled = !keywordSaveEnabled\(/);
});
