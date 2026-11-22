import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  springLinear, SPRING, slideX, digitPlan, shouldAnimateCard,
  markJustAdded, takeJustAdded, reducedMotion, DUR, pickEasing, SPRING_FALLBACK, EASE_OUT, rollRuns, animate, flipPlan,
} from '../js/ui/motion.js';

test('springLinear：41 个点、首 0 尾 1、最大值 ≈ 1+p', () => {
  for (const p of [0.08, 0.04, 0.01]) {
    const s = springLinear(p);
    assert.ok(s.startsWith('linear(') && s.endsWith(')'));
    const pts = s.slice(7, -1).split(', ').map(Number);
    assert.equal(pts.length, 41);
    assert.equal(pts[0], 0);
    assert.equal(pts[40], 1);
    assert.ok(Math.abs(Math.max(...pts) - (1 + p)) < 0.003, `max ${Math.max(...pts)}`);
  }
  assert.equal(SPRING, springLinear(0.04));
});

test('slideX：滑入做法的 transform', () => {
  assert.equal(slideX(0), 'translateX(-100%)');
  assert.equal(slideX(0.25), 'translateX(-75.00%)');
  assert.equal(slideX(1), 'translateX(0.00%)');
  assert.equal(slideX(1.4), 'translateX(0.00%)');
  assert.equal(slideX(-1), 'translateX(-100%)');
  assert.equal(slideX(0.3, 6), 'translateX(calc(max(6px, 30.00%) - 100%))');
  assert.equal(slideX(0, 6), 'translateX(-100%)');
});

test('digitPlan：由右对齐，新多出的位数从 0 滚上来', () => {
  const p = digitPlan('999', '1,000');
  assert.equal(p.map((x) => x.ch).join(''), '1,000');
  assert.deepEqual(p.filter((x) => x.digit).map((x) => [x.from, x.to, x.rank]),
    [[0, 1, 3], [9, 0, 2], [9, 0, 1], [9, 0, 0]]);
  assert.equal(p[1].digit, false);
});

test('digitPlan：旧字串没有数字（首次、••••）→ 不滚；位数变少 → 由右对齐', () => {
  for (const old of ['', '••••']) {
    assert.ok(digitPlan(old, '12').every((x) => x.from === x.to), old);
  }
  assert.ok(digitPlan('12', '••••').every((x) => !x.digit));
  assert.deepEqual(digitPlan('1,234', '234').filter((x) => x.digit).map((x) => x.from), [2, 3, 4]);
});

test('shouldAnimateCard：只有资料变动、非首次、非隐藏才动画', () => {
  assert.equal(shouldAnimateCard({ first: false, hidden: false, reason: 'data' }), true);
  for (const c of [
    { first: true, hidden: false, reason: 'data' },
    { first: false, hidden: true, reason: 'data' },
    { first: false, hidden: false, reason: 'wake' },
    { first: false, hidden: false, reason: 'hide' },
    { first: false, hidden: false, reason: 'more' },
  ]) assert.equal(shouldAnimateCard(c), false, JSON.stringify(c));
});

test('markJustAdded / takeJustAdded：取一次就清掉', () => {
  markJustAdded('a');
  assert.equal(takeJustAdded('a'), true);
  assert.equal(takeJustAdded('a'), false);
  assert.equal(takeJustAdded('b'), false);
});

test('reducedMotion：Node 没有 matchMedia 时为 false', () => {
  assert.equal(reducedMotion(), false);
});

test('DUR：spec 的时长', () => {
  assert.deepEqual(DUR, {
    roll: 250, bar: 250, rowMove: 220, rowIn: 200, rowOut: 180, pop: 180,
    tab: 200, draw: 250, dot: 180, monthOut: 100, monthIn: 200,
    fade: 200, float: 800, barStagger: 20, barDelay: 40, digitStagger: 12,
  });
});

test('pickEasing：支援 linear() 就用原曲线；不支援时弹簧 → 后备', () => {
  assert.equal(pickEasing(SPRING, true), SPRING);
  assert.equal(pickEasing(SPRING, false), SPRING_FALLBACK);
  assert.equal(pickEasing('ease', false), 'ease');
});

test('digitPlan：小数位逐位对齐（.05 → .50）', () => {
  assert.deepEqual(digitPlan('.05', '.50').filter((x) => x.digit).map((x) => [x.from, x.to]), [[0, 5], [5, 0]]);
});

test('rollRuns：连续的非数字字元合成一段，数字各自一段', () => {
  assert.deepEqual(rollRuns(digitPlan('', 'RM 1,2')).map((r) => (r.digit ? r.to : r.text)), ['RM ', 1, ',', 2]);
  assert.deepEqual(rollRuns(digitPlan('', '••••')).map((r) => r.text), ['••••']);
});

test('animate：浏览器的 animate 抛错时回传 null（动画是装饰，不能弄坏功能）', () => {
  const el = { animate() { throw new TypeError('bad easing'); } };
  assert.equal(animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 100 }), null);
  assert.equal(animate(null, [], { duration: 1 }), null);
});

test('flipPlan：留下的元素位移、新元素进场、巢状只算相对位移、父进场子不动、画面外与 skip 不动', () => {
  // items：依文件顺序；parent = 最近的 [data-flip] 祖先在 items 里的索引（没有 = -1）
  const items = [
    { key: 'd1', top: 100, parent: -1 },   // 日期区块往下移 50
    { key: 't1', top: 130, parent: 0 },    // 列：画面上移 60 → 相对父 10
    { key: 'd2', top: 300, parent: -1 },   // 新日期区块
    { key: 't2', top: 330, parent: 2 },    // 新区块里的新列：不另外动
    { key: 't3', top: 2000, parent: -1 },  // 画面外
    { key: 't4', top: 400, parent: -1, skip: true }, // 正在滑出
  ];
  const before = new Map([['d1', 50], ['t1', 70], ['t3', 1900], ['t4', 380]]);
  const plan = flipPlan(items, before, { vh: 800, isEnter: () => true });
  assert.deepEqual([...plan.entries()], [[0, { dy: -50 }], [1, { dy: -10 }], [2, { enter: true, dy: 0 }]]);
});

test('数字滚轮用 EASE_OUT（弹簧会让 0→9 冲过头露出下一格）', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/motion.js', import.meta.url), 'utf8');
  const roll = js.slice(js.indexOf('export function rollTo('), js.indexOf('// ---------- FLIP'));
  assert.match(roll, /duration: DUR\.roll, delay: r\.rank \* DUR\.digitStagger, easing: EASE_OUT/);
  assert.ok(!/SPRING_SHEET/.test(js), 'SPRING_SHEET 已删除');
});
