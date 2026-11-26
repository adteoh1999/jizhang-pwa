import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushLayer, popLayer, depth, onDepthChange, whenIdle, trackExit, isIdle, canPop } from '../js/ui/nav.js';

// nav.js 是模块级单例：每个测试后清空堆叠。
// 有 onDismiss 的层 popLayer 不会关闭，所以设上限，避免无限循环（剩下的层由测试自己 close）
afterEach(() => {
  for (let i = 0; i < 100 && depth() > 0; i += 1) popLayer();
  assert.equal(depth(), 0, '测试结束时仍有浮层未关闭');
  let idle = false;
  whenIdle(() => { idle = true; });
  assert.ok(idle, '测试结束时仍有未 release 的退场');
});

test('Node 环境（没有 document）可以载入 nav.js', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(depth(), 0);
});

test('close() 幂等：onClose 只呼叫一次，depth 只减一次', () => {
  let calls = 0;
  pushLayer({ onClose: () => {} });
  const h = pushLayer({ onClose: () => { calls += 1; } });
  assert.equal(depth(), 2);
  h.close();
  h.close();
  assert.equal(calls, 1);
  assert.equal(depth(), 1);
});

test('关闭中间一层：只移除那一层，其他层不受影响', () => {
  const closed = [];
  const a = pushLayer({ onClose: () => closed.push('a') });
  const b = pushLayer({ onClose: () => closed.push('b') });
  pushLayer({ onClose: () => closed.push('c') });
  b.close();
  assert.deepEqual(closed, ['b']);
  assert.equal(depth(), 2);
  popLayer();
  assert.deepEqual(closed, ['b', 'c']);
  a.close();
  assert.deepEqual(closed, ['b', 'c', 'a']);
  assert.equal(depth(), 0);
});

test('popLayer 依 LIFO 顺序关闭；空堆叠时不做事', () => {
  const closed = [];
  pushLayer({ onClose: () => closed.push(1) });
  pushLayer({ onClose: () => closed.push(2) });
  pushLayer({ onClose: () => closed.push(3) });
  popLayer(); popLayer(); popLayer();
  assert.deepEqual(closed, [3, 2, 1]);
  assert.doesNotThrow(() => popLayer());
  assert.equal(depth(), 0);
});

test('depth 监听：每次 push / close 各通知一次，重复 close 不通知；取消订阅后不再通知', () => {
  const seen = [];
  const off = onDepthChange((d) => seen.push(d));
  const a = pushLayer({});
  const b = pushLayer({});
  b.close();
  b.close();
  a.close();
  assert.deepEqual(seen, [1, 2, 1, 0]);
  off();
  pushLayer({});
  assert.deepEqual(seen, [1, 2, 1, 0]);
});

test('关闭时先通知 depth 监听，再呼叫 onClose（焦点还原需要先解除 inert）', () => {
  const order = [];
  const off = onDepthChange((d) => order.push(`depth:${d}`));
  const h = pushLayer({ onClose: () => order.push(`onClose:depth=${depth()}`) });
  h.close();
  off();
  assert.deepEqual(order, ['depth:1', 'depth:0', 'onClose:depth=0']);
});

test('onClose 抛错不会破坏堆叠', () => {
  const origError = console.error;
  const logged = [];
  console.error = (e) => logged.push(e);
  try {
    const a = pushLayer({ onClose: () => { throw new Error('boom'); } });
    const b = pushLayer({ onClose: () => { throw new Error('boom2'); } });
    popLayer();
    assert.equal(depth(), 1);
    a.close();
    assert.equal(depth(), 0);
    b.close(); // 已关闭：不做事
    assert.equal(logged.length, 2);
  } finally {
    console.error = origError;
  }
  const c = pushLayer({});
  assert.equal(depth(), 1);
  c.close();
  assert.equal(depth(), 0);
});

test('element：只有最上层的元素可操作，其他层的元素 inert；上层关闭后下层恢复', () => {
  const a = { inert: false };
  const b = { inert: false };
  const ha = pushLayer({ element: a });
  assert.equal(a.inert, false);
  const hb = pushLayer({ element: b });
  assert.equal(a.inert, true);
  assert.equal(b.inert, false);
  pushLayer({}); // 没有元素的层也算最上层
  assert.equal(b.inert, true);
  popLayer();
  assert.equal(b.inert, false);
  hb.close();
  assert.equal(b.inert, true, '已关闭的层（退场动画中）不可操作');
  assert.equal(a.inert, false);
  ha.close();
  assert.equal(a.inert, true);
});

test('关闭上层时，下层元素在 onClose（焦点还原）之前就已解除 inert', () => {
  const a = { inert: false };
  pushLayer({ element: a });
  let seen = null;
  const hb = pushLayer({ element: { inert: false }, onClose: () => { seen = a.inert; } });
  hb.close();
  assert.equal(seen, false);
});

test('onDismiss：popLayer 交给 onDismiss 决定（不直接关闭）；close() 仍直接关闭', () => {
  let asked = 0;
  let closed = 0;
  const h = pushLayer({ onDismiss: () => { asked += 1; }, onClose: () => { closed += 1; } });
  try {
    popLayer();
    assert.equal(asked, 1);
    assert.equal(closed, 0);
    assert.equal(depth(), 1);
  } finally {
    h.close();
  }
  assert.equal(closed, 1);
  assert.equal(depth(), 0);
});

test('whenIdle：没有浮层时同步执行', () => {
  let n = 0;
  whenIdle(() => { n += 1; });
  assert.equal(n, 1);
});

test('whenIdle：等浮层关闭且退场 release 后才执行，只执行一次', () => {
  const h = pushLayer({ onClose: () => {} });
  let n = 0;
  whenIdle(() => { n += 1; });
  const release = trackExit();
  h.close();
  assert.equal(n, 0, '还有退场动画没播完');
  release();
  release();
  assert.equal(n, 1);
});

test('whenIdle：依加入顺序执行', () => {
  const h = pushLayer({ onClose: () => {} });
  const order = [];
  whenIdle(() => order.push(1));
  whenIdle(() => order.push(2));
  h.close();
  assert.deepEqual(order, [1, 2]);
});

test('whenIdle：在 onClose 里才登记退场（sheet.js 的真实顺序）→ release 后才执行', () => {
  let release = null;
  const h = pushLayer({ onClose: () => { release = trackExit(); } });
  let n = 0;
  whenIdle(() => { n += 1; });
  h.close();
  assert.equal(n, 0, '面板退场还没播完就执行了');
  release();
  assert.equal(n, 1);
});

test('whenIdle：回调里又开新浮层 → 队列剩下的等下一次闲置', () => {
  const h = pushLayer({ onClose: () => {} });
  const order = [];
  let h2 = null;
  whenIdle(() => { order.push(1); h2 = pushLayer({ onClose: () => {} }); });
  whenIdle(() => order.push(2));
  h.close();
  assert.deepEqual(order, [1]);
  h2.close();
  assert.deepEqual(order, [1, 2]);
});

test('trackExit：没被 release 时，保险计时到了自动 release', async () => {
  const h = pushLayer({ onClose: () => {} });
  let n = 0;
  whenIdle(() => { n += 1; });
  trackExit({ timeout: 20 });
  h.close();
  assert.equal(n, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1);
});

test('isIdle：没有浮层且退场都 release 才是 true', () => {
  assert.equal(isIdle(), true);
  let release;
  const h = pushLayer({ onClose: () => { release = trackExit(); } });
  assert.equal(isIdle(), false, '有浮层');
  h.close();
  assert.equal(isIdle(), false, '退场还没播完');
  release();
  assert.equal(isIdle(), true);
});

// ---------- 3c-2：locked 层（「正在…」遮罩）与 canPop（Telegram 返回键用） ----------
test('canPop：空栈 false；一般层 true', () => {
  assert.equal(canPop(), false);
  const a = pushLayer({});
  assert.equal(canPop(), true);
  a.close();
  assert.equal(canPop(), false);
});

test('canPop：最上层 locked → false（底下有 sheet 也一样）；locked 关掉后恢复', () => {
  pushLayer({});
  const lock = pushLayer({ locked: true, onDismiss: () => {} });
  assert.equal(canPop(), false);
  lock.close();
  assert.equal(canPop(), true);
});

test('popLayer：最上层 locked → 不做事（连 onDismiss 也不叫）', () => {
  let dismissed = 0;
  let closed = 0;
  pushLayer({ onClose: () => { closed += 1; } });
  const lock = pushLayer({ locked: true, onDismiss: () => { dismissed += 1; } });
  popLayer();
  assert.equal(dismissed, 0);
  assert.equal(closed, 0);
  assert.equal(depth(), 2);
  lock.close();
});
