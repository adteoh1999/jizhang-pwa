import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onUpdateAvailable, markUpdateAvailable, applyUpdate } from '../js/update.js';

// 模块是单例：测试按顺序跑，状态会累积
const worker = () => { const w = { sent: [], postMessage(m) { this.sent.push(m); } }; return w; };

test('订阅后 mark：通知一次；重复 mark 不再通知', () => {
  let n = 0;
  onUpdateAvailable(() => n++);
  const w1 = worker();
  markUpdateAvailable({ waiting: w1 }, w1);
  markUpdateAvailable({ waiting: w1 }, w1);
  assert.equal(n, 1);
});

test('晚订阅者立刻收到一次重播；取消订阅后不再收到', () => {
  let late = 0;
  const off = onUpdateAvailable(() => late++);
  assert.equal(late, 1);
  off();
  const w = worker();
  markUpdateAvailable({ waiting: w }, w);
  assert.equal(late, 1);
});

test('applyUpdate 优先用 reg.waiting，没有则用记下的 worker', () => {
  const captured = worker();
  const waiting = worker();
  markUpdateAvailable({ waiting }, captured);
  applyUpdate();
  assert.deepEqual(waiting.sent, [{ type: 'SKIP_WAITING' }]);
  assert.deepEqual(captured.sent, []);
  markUpdateAvailable({ waiting: null }, captured); // 永远记最新的
  applyUpdate();
  assert.deepEqual(captured.sent, [{ type: 'SKIP_WAITING' }]);
});
