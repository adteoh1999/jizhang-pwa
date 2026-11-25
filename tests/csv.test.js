import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADER, toCSV, parseCSV, planImport } from '../js/csv.js';
import { defaultCategories, nextUpdatedAt } from '../js/model.js';
import { isUuid } from '../js/timefmt.js';

const cats = defaultCategories();
const byId = new Map(cats.map((c) => [c.id, c]));
const now = new Date('2026-11-20T10:00:00.000Z');
let n = 0;
const uuid = () => `new-${++n}`;
const U1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ctx = (extra = {}) => ({ existingTxs: new Map(), categories: cats, now, uuid, ...extra });
const T = (o) => ({
  id: U1, kind: 'expense', amount_minor: 1250, category_id: 'food', occurred_on: '2026-11-20',
  note: '', created_at: '2026-11-20T01:00:00.000Z', updated_at: '2026-11-20T01:00:00.000Z',
  deleted: false, dirty: 0, ...o,
});

test('往返：中文、逗号、引号、换行', () => {
  const txs = [T({ note: '午餐, 和"老王"\n第二行' })];
  const csv = toCSV(txs, byId);
  assert.ok(csv.startsWith('\ufeff'));
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.split('\r\n')[0].slice(1), CSV_HEADER.join(','));
  const plan = planImport(parseCSV(csv), ctx({ existingTxs: new Map(txs.map((t) => [t.id, t])) }));
  assert.equal(plan.imported, 0);
  assert.equal(plan.skipped, 1);
  const fresh = planImport(parseCSV(csv), ctx());
  assert.equal(fresh.txs[0].note, '午餐, 和"老王"\n第二行');
  assert.equal(fresh.txs[0].amount_minor, txs[0].amount_minor);
  assert.equal(fresh.txs[0].id, txs[0].id);
  assert.equal(fresh.txs[0].category_id, 'food');
  assert.equal(fresh.txs[0].dirty, 1);
});

test('toCSV 跳过已删除、前后空白加引号、未知分类', () => {
  const csv = toCSV([T({ note: ' x ', category_id: 'zzz' }), T({ id: 't2', deleted: true })], byId);
  const rows = parseCSV(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][4], '未分类');
  assert.equal(rows[1][5], ' x ');
  assert.ok(csv.includes('," x ",'));
});

test('Excel 另存：CRLF、无 BOM、栏位顺序不同', () => {
  const text = 'date,amount,kind,category,note\r\n2026-11-03,12.5,expense,餐饮,早餐\r\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].amount_minor, 1250);
  assert.equal(plan.txs[0].category_id, 'food');
  assert.equal(plan.txs[0].note, '早餐');
});

test('未知分类自动新建，同名只建一个', () => {
  const text = 'date,kind,amount,category\n2026-11-01,expense,1,宠物\n2026-11-02,expense,2,宠物\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.newCategories.length, 1);
  assert.equal(plan.newCategories[0].icon, 'other');
  assert.equal(plan.newCategories[0].sort, 6);
  assert.equal(plan.txs[0].category_id, plan.txs[1].category_id);
  const inc = planImport(parseCSV('date,kind,amount,category\n2026-11-01,income,1,宠物\n'), ctx());
  assert.equal(inc.newCategories[0].icon, 'other_income');
  assert.equal(inc.newCategories[0].sort, 4);
});

test('非 MYR 与坏资料被略过', () => {
  const text = 'date,kind,amount,category,currency\n'
    + '2026-11-01,expense,5,餐饮,SGD\n'
    + '2026-11-01,expense,abc,餐饮,MYR\n'
    + '2026-02-30,expense,5,餐饮,\n'
    + '\n'
    + '2026-11-01,expense,5,餐饮,myr\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.skipped, 3);
  assert.equal(plan.imported, 1);
});

test('本地已删除的纪录会被导入恢复', () => {
  const ex = T({ deleted: true });
  const text = `id,date,kind,amount,category,updated_at\n${U1},2026-11-20,expense,12.50,餐饮,\n`;
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([[U1, ex]]) }));
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].deleted, false);
  assert.equal(plan.txs[0].created_at, ex.created_at);
});

test('较新的 updated_at 覆盖已存在纪录', () => {
  const ex = T();
  const text = `id,date,kind,amount,category,updated_at\n${U1},2026-11-20,expense,20,餐饮,2026-11-21T00:00:00.000Z\n`;
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([[U1, ex]]) }));
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].amount_minor, 2000);
  assert.equal(plan.txs[0].updated_at, nextUpdatedAt(ex.updated_at, now));
  assert.equal(plan.txs[0].updated_at, now.toISOString());
});

test('Excel 日期 20/11/2026 与 2026/11/5', () => {
  const text = 'date,kind,amount,category\n20/11/2026,expense,1,餐饮\n2026/11/5,expense,1,餐饮\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.txs[0].occurred_on, '2026-11-20');
  assert.equal(plan.txs[1].occurred_on, '2026-11-05');
});

test('updated_at 空白不会覆盖已存在的纪录', () => {
  const text = `id,date,kind,amount,category,updated_at\n${U1},2026-11-20,expense,20,餐饮,\n`;
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([[U1, T()]]) }));
  assert.equal(plan.skipped, 1);
  assert.equal(plan.imported, 0);
});

test('新建纪录的 created_at 保留档案顺序', () => {
  const text = 'date,kind,amount,category\n2026-11-01,expense,1,餐饮\n2026-11-01,expense,2,餐饮\n';
  const plan = planImport(parseCSV(text), ctx());
  assert.ok(plan.txs[0].created_at > plan.txs[1].created_at);
  assert.equal(plan.txs[0].created_at, now.toISOString());
});

test('缺少必要栏位丢错', () => {
  assert.throws(() => planImport([['note'], ['x']], ctx()), /缺少必要栏位/);
});

test('parseCSV：引号、空行', () => {
  assert.deepEqual(parseCSV('\ufeffa,"b,""c"""\n\n'), [['a', 'b,"c"']]);
  assert.deepEqual(parseCSV('a\r\nb'), [['a'], ['b']]);
});

test('分类比对忽略已删除分类', () => {
  const old = { id: 'old-pet', kind: 'expense', name: '宠物', icon: 'other', sort: 9, updated_at: '1970-01-01T00:00:00.000Z', deleted: true, dirty: 0 };
  const plan = planImport(parseCSV('date,kind,amount,category\n2026-11-01,expense,1,宠物\n'), ctx({ categories: [...cats, old] }));
  assert.equal(plan.newCategories.length, 1);
  assert.notEqual(plan.newCategories[0].id, 'old-pet');
  assert.equal(plan.newCategories[0].sort, 10);
  assert.equal(plan.txs[0].category_id, plan.newCategories[0].id);
});

test('toCSV 顺序：日期新→旧，同日 created_at 新→旧', () => {
  const txs = [
    T({ id: 'x1', occurred_on: '2026-11-01', created_at: '2026-11-01T01:00:00.000Z' }),
    T({ id: 'x2', occurred_on: '2026-11-02', created_at: '2026-11-02T01:00:00.000Z' }),
    T({ id: 'x3', occurred_on: '2026-11-02', created_at: '2026-11-02T05:00:00.000Z' }),
  ];
  assert.deepEqual(parseCSV(toCSV(txs, byId)).slice(1).map((r) => r[0]), ['x3', 'x2', 'x1']);
});

test('日期歧义：5/11/2026 日在前；1/13/2026 略过', () => {
  const plan = planImport(parseCSV('date,kind,amount,category\n5/11/2026,expense,1,餐饮\n1/13/2026,expense,1,餐饮\n'), ctx());
  assert.equal(plan.txs[0].occurred_on, '2026-11-05');
  assert.equal(plan.imported, 1);
  assert.equal(plan.skipped, 1);
});

test('引号没有闭合丢错', () => {
  assert.throws(() => parseCSV('a,"b\nc'), /引号没有闭合/);
});

test('非 uuid 的 id（本机没有这笔）换新 uuid', () => {
  const text = 'id,date,kind,amount,category,updated_at\nabc,2026-11-20,expense,20,餐饮,2026-11-21T00:00:00.000Z\n';
  const plan = planImport(parseCSV(text), ctx({ uuid: () => crypto.randomUUID() }));
  assert.equal(plan.imported, 1);
  assert.equal(isUuid(plan.txs[0].id), true);
  assert.equal(plan.txs[0].created_at, now.toISOString());
});

test('id 原样等于本机某笔（旧版导入留下的非 uuid / 大写 id）→ 当成同一笔，导出再导入不会重复', () => {
  for (const oddId of ['abc', U1.toUpperCase()]) {
    const ex = T({ id: oddId });
    const same = `id,date,kind,amount,category,updated_at\n${oddId},2026-11-20,expense,12.50,餐饮,\n`;
    let plan = planImport(parseCSV(same), ctx({ existingTxs: new Map([[oddId, ex]]) }));
    assert.deepEqual([plan.imported, plan.skipped], [0, 1], oddId);
    const newer = `id,date,kind,amount,category,updated_at\n${oddId},2026-11-20,expense,20,餐饮,2026-11-21T00:00:00.000Z\n`;
    plan = planImport(parseCSV(newer), ctx({ existingTxs: new Map([[oddId, ex]]) }));
    assert.equal(plan.imported, 1);
    assert.equal(plan.txs[0].id, oddId); // 沿用本机那笔的 key（认领时 markAllForUpload 再统一换）
    assert.equal(plan.txs[0].created_at, ex.created_at);
  }
});

test('合法 uuid 前后有空白照常比对；大写 + 较新 → 覆盖本机小写那笔', () => {
  let plan = planImport(parseCSV(`id,date,kind,amount,category,updated_at\n  ${U1}  ,2026-11-20,expense,20,餐饮,\n`), ctx({ existingTxs: new Map([[U1, T()]]) }));
  assert.equal(plan.skipped, 1);
  plan = planImport(parseCSV(`id,date,kind,amount,category,updated_at\n${U1.toUpperCase()},2026-11-20,expense,20,餐饮,2026-11-21T00:00:00.000Z\n`), ctx({ existingTxs: new Map([[U1, T()]]) }));
  assert.equal(plan.imported, 1);
  assert.equal(plan.txs[0].id, U1);
  assert.equal(plan.txs[0].created_at, T().created_at);
});

test('合法 uuid 保留原 id；大写转小写后比对已存在', () => {
  const fresh = planImport(parseCSV(`id,date,kind,amount,category\n${U1},2026-11-20,expense,1,餐饮\n`), ctx());
  assert.equal(fresh.txs[0].id, U1);
  const text = `id,date,kind,amount,category,updated_at\n${U1.toUpperCase()},2026-11-20,expense,20,餐饮,\n`;
  const plan = planImport(parseCSV(text), ctx({ existingTxs: new Map([[U1, T()]]) }));
  assert.equal(plan.skipped, 1); // 已存在、updated_at 空白 → 略过
  const up = planImport(parseCSV(`id,date,kind,amount,category\n${U1.toUpperCase()},2026-11-20,expense,1,餐饮\n`), ctx());
  assert.equal(up.txs[0].id, U1);
});

test('同一档案里大小写不同的同一 uuid 只导入一次', () => {
  const text = `id,date,kind,amount,category\n${U1},2026-11-20,expense,1,餐饮\n${U1.toUpperCase()},2026-11-20,expense,2,餐饮\n`;
  const plan = planImport(parseCSV(text), ctx());
  assert.equal(plan.imported, 1);
  assert.equal(plan.skipped, 1);
});

test('多列非 uuid 的 id（即使相同）都各自换新、都导入', () => {
  const text = 'id,date,kind,amount,category\nabc,2026-11-20,expense,1,餐饮\nabc,2026-11-20,expense,2,餐饮\n';
  const plan = planImport(parseCSV(text), ctx({ uuid: () => crypto.randomUUID() }));
  assert.equal(plan.imported, 2);
  assert.notEqual(plan.txs[0].id, plan.txs[1].id);
});
