// 3b-9：「Telegram 已解除连接」流程（js/ui/tg-gone.js）与共用全屏画面（js/ui/fatal.js）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTgGone, TG_GONE_TEXT } from '../js/ui/tg-gone.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';

async function makeStore({ owner = 'u-A', txs = 0 } = {}) {
  const store = createStore({ db: createMemoryDb() });
  await store.init();
  for (let i = 0; i < txs; i++) await store.saveTransaction({ kind: 'expense', amountMinor: 1 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  if (owner) await store.setMetas({ owner_user_id: owner });
  return store;
}

function goneDeps(store, answers, { wipeOk = [true] } = {}) {
  const log = { choices: [], stops: 0, wipes: 0, reloads: 0, closed: 0, resets: 0, messages: [], exports: 0 };
  let a = 0;
  let w = 0;
  return {
    log,
    deps: {
      store,
      stop: () => { log.stops += 1; },
      wipe: async () => { log.wipes += 1; return wipeOk[Math.min(w++, wipeOk.length - 1)]; },
      reload: () => { log.reloads += 1; },
      choice: async (o) => { log.choices.push(o); return answers[Math.min(a++, answers.length - 1)]; },
      message: async (o) => { log.messages.push(o); },
      exportCsv: () => { log.exports += 1; },
      closeMiniApp: () => { log.closed += 1; },
      announceReset: () => { log.resets += 1; },
      onClosed: () => { log.onClosed = (log.onClosed || 0) + 1; },
    },
  };
}

test('runTgGone：都上传了 → 「先关闭」（焦点、左）＋「清除」（红、右），没有导出；先停同步；关闭后画挡画面', async () => {
  const store = await makeStore();
  const { deps, log } = goneDeps(store, ['close']);
  assert.equal(await runTgGone(deps), 'closed');
  assert.equal(log.stops, 1);
  const c = log.choices[0];
  assert.equal(c.title, 'Telegram 已解除连接');
  assert.equal(c.message, '这台设备上的账本会清除。');
  assert.deepEqual(c.buttons.map((b) => b.label), ['先关闭', '清除']);
  assert.equal(c.buttons[1].destructive, true);
  assert.equal(c.buttons[0].focus, true);
  assert.equal(log.closed, 1);
  assert.equal(log.onClosed, 1, 'close() 没作用时也不是白屏');
  assert.equal(log.wipes, 0);
});

test('runTgGone：有没上传的 → 内文多两句（笔数、请先关闭）；Telegram 里不提供导出（用户 2026-11-26 选：3b 先拿掉）', async () => {
  const store = await makeStore({ owner: null, txs: 3 });
  const { deps, log } = goneDeps(store, ['close']);
  await runTgGone(deps);
  const c = log.choices[0];
  assert.equal(c.message, '这台设备上的账本会清除。还有 3 笔没上传，清除后会消失。要保留没上传的记录，请先按「先关闭」。');
  assert.deepEqual(c.buttons.map((b) => b.label), ['先关闭', '清除']);
  assert.equal(log.exports, 0);
});

test('runTgGone：按「清除」→ wipe、announceReset、reload', async () => {
  const store = await makeStore();
  const { deps, log } = goneDeps(store, ['clear']);
  assert.equal(await runTgGone(deps), 'cleared');
  assert.deepEqual([log.wipes, log.resets, log.reloads, log.closed], [1, 1, 1, 0]);
});

test('runTgGone：清除失败 → 「清除失败，请再试一次」、不 reload，回到对话框；再按清除成功', async () => {
  const store = await makeStore();
  const { deps, log } = goneDeps(store, ['clear', 'clear'], { wipeOk: [false, true] });
  assert.equal(await runTgGone(deps), 'cleared');
  assert.equal(log.messages[0].title, TG_GONE_TEXT.failTitle);
  assert.equal(TG_GONE_TEXT.failTitle, '清除失败，请再试一次');
  assert.equal(log.choices.length, 2);
  assert.equal(log.reloads, 1);
  assert.equal(log.resets, 1);
});

test('runTgGone：Esc 关掉（null）当「先关闭」', async () => {
  const store = await makeStore();
  const { deps, log } = goneDeps(store, [null]);
  assert.equal(await runTgGone(deps), 'closed');
  assert.equal(log.closed, 1);
});

// ---------------- 全屏画面（js/ui/fatal.js） ----------------

// 最小的假 DOM：只够 h() 和 renderFatal 用（元素要是 Node 的实例，h() 才当成子元素）
class FakeNode {}
function fakeDocument() {
  const mk = (tag) => {
    const el = new FakeNode();
    Object.assign(el, {
      tagName: tag.toUpperCase(), className: '', attrs: {}, children: [], listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      focus() { this.focused = true; },
      addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
      append(...cs) { for (const c of cs) this.children.push(typeof c === 'string' ? { text: c } : c); },
      replaceChildren(...cs) { this.children = []; this.append(...cs); },
    });
    Object.defineProperty(el, 'textContent', { get() { return this.children.map((c) => (c.text !== undefined ? c.text : c.textContent)).join(''); } });
    return el;
  };
  return { createElement: mk };
}

test('renderFatal：标题、内文、按钮（点了叫 onClick）；renderDbError 文字不变', async () => {
  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  globalThis.document = fakeDocument();
  globalThis.Node = FakeNode;
  try {
    const { renderFatal, renderDbError } = await import('../js/ui/fatal.js');
    const root = globalThis.document.createElement('div');
    let clicked = 0;
    renderFatal(root, { title: '需要网络', message: '连上网络后再试。', buttonLabel: '再试一次', onClick: () => { clicked += 1; } });
    const box = root.children[0];
    assert.equal(box.className, 'fatal');
    assert.equal(box.attrs.role, 'alert');
    const [h1, p, btn] = box.children;
    assert.equal(h1.textContent, '需要网络');
    assert.equal(p.textContent, '连上网络后再试。');
    assert.equal(btn.textContent, '再试一次');
    btn.listeners.click[0]();
    assert.equal(clicked, 1);
    assert.equal(h1.attrs.tabindex, '-1');
    assert.equal(h1.focused, true, '换成挡画面后焦点移到标题（读屏）');

    renderDbError(root, new Error('IndexedDB 已停用'));
    const [t2, m2, b2] = root.children[0].children;
    assert.equal(t2.textContent, '无法开启资料库');
    assert.equal(m2.textContent, 'IndexedDB 已停用');
    assert.equal(b2.textContent, '重新整理');
  } finally {
    globalThis.document = prevDoc;
    globalThis.Node = prevNode;
  }
});

test('fatal.js：「正在载入…」用 announce 念（role=status 跟内容一起插入时 VoiceOver 常不念）', () => {
  const src = readFileSync(new URL('../js/ui/fatal.js', import.meta.url), 'utf8');
  assert.match(src, /announce\(text\)/);
});

test('renderFatal：没给 buttonLabel → 不放按钮（Telegram 内建浏览器里「关闭」没作用，实测 7）', async () => {
  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  globalThis.document = fakeDocument();
  globalThis.Node = FakeNode;
  try {
    const { renderFatal } = await import('../js/ui/fatal.js');
    const root = globalThis.document.createElement('div');
    renderFatal(root, { title: 'T', message: 'M' });
    const box = root.children[0];
    assert.equal(box.children.length, 2);
    assert.deepEqual(box.children.map((c) => c.tagName), ['H1', 'P']);
  } finally {
    globalThis.document = prevDoc;
    globalThis.Node = prevNode;
  }
});
