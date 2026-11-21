import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  springLinear, SPRING, SPRING_SHEET, slideX, digitPlan, shouldAnimateCard,
  markJustAdded, takeJustAdded, reducedMotion, DUR, pickEasing, SPRING_FALLBACK, EASE_OUT, rollRuns,
} from '../js/ui/motion.js';

test('springLinear：41 个点、首 0 尾 1、最大值 ≈ 1+p', () => {
  for (const p of [0.08, 0.01]) {
    const s = springLinear(p);
    assert.ok(s.startsWith('linear(') && s.endsWith(')'));
    const pts = s.slice(7, -1).split(', ').map(Number);
    assert.equal(pts.length, 41);
    assert.equal(pts[0], 0);
    assert.equal(pts[40], 1);
    assert.ok(Math.abs(Math.max(...pts) - (1 + p)) < 0.003, `max ${Math.max(...pts)}`);
  }
  assert.equal(SPRING, springLinear(0.08));
  assert.equal(SPRING_SHEET, springLinear(0.01));
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
    roll: 420, bar: 420, rowMove: 360, rowIn: 380, rowOut: 260, sheetIn: 460, pop: 360,
    check: 380, checkHold: 350, tab: 320, draw: 420, dot: 340, monthOut: 160, monthIn: 340,
    fade: 200, float: 1200, barStagger: 55, barDelay: 120, digitStagger: 22,
  });
});

test('pickEasing：支援 linear() 就用原曲线；不支援时面板 → EASE_OUT、其他弹簧 → 后备', () => {
  assert.equal(pickEasing(SPRING, true), SPRING);
  assert.equal(pickEasing(SPRING, false), SPRING_FALLBACK);
  assert.equal(pickEasing(SPRING_SHEET, false), EASE_OUT);
  assert.equal(pickEasing('ease', false), 'ease');
});

test('digitPlan：小数位逐位对齐（.05 → .50）', () => {
  assert.deepEqual(digitPlan('.05', '.50').filter((x) => x.digit).map((x) => [x.from, x.to]), [[0, 5], [5, 0]]);
});

test('rollRuns：连续的非数字字元合成一段，数字各自一段', () => {
  assert.deepEqual(rollRuns(digitPlan('', 'RM 1,2')).map((r) => (r.digit ? r.to : r.text)), ['RM ', 1, ',', 2]);
  assert.deepEqual(rollRuns(digitPlan('', '••••')).map((r) => r.text), ['••••']);
});
