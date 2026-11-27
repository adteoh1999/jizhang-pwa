// 3e 设置页关键词画面：纯函数（清单列、错误文字、编辑起始状态、储存键、设置列）＋接线检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  keywordRows, keywordErrorText, keywordEditorStart, keywordSaveEnabled, keywordCountDetail, KEYWORD_HELP,
} from '../js/ui/keywords-page.js';
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

test('接线：设置页「分类」组有「关键词」列与组尾说明；sw.js 离线清单有 keywords-page.js', () => {
  const s = src('js/ui/settings.js');
  assert.match(s, /openKeywordsPage\(store\)/);
  assert.match(s, /'关键词'/);
  assert.match(s, /在 Telegram 记账时，备注或店名有你的关键词，就一定记成对应的分类（需要先连接 Telegram）。/);
  assert.match(src('sw.js'), /'\.\/js\/ui\/keywords-page\.js'/);
});

test('接线：关键词输入框关掉自动大写、自动更正、拼字检查；储存键依 keywordSaveEnabled 停用', () => {
  const k = src('js/ui/keywords-page.js');
  for (const a of ["autocapitalize: 'none'", "autocorrect: 'off'", "spellcheck: 'false'", "enterkeyhint: 'done'", "autocomplete: 'off'"]) {
    assert.ok(k.includes(a), a);
  }
  assert.match(k, /sheet\.rightButton\.disabled = !keywordSaveEnabled\(/);
});
