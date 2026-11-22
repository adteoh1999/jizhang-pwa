import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnnouncer } from '../js/ui/announce.js';

// 假 document：只做 announce.js 用到的部分
function fakeDoc() {
  const body = { children: [], append(el) { this.children.push(el); el.isConnected = true; } };
  return {
    body,
    createElement(tag) {
      return { tag, attrs: {}, className: '', textContent: '', isConnected: false,
        setAttribute(k, v) { this.attrs[k] = v; } };
    },
  };
}
// 手动计时器
function fakeTimers() {
  const q = new Map(); let n = 0; const delays = [];
  return {
    delays,
    schedule: (fn, ms) => { delays.push(ms); q.set(++n, fn); return n; },
    cancel: (id) => { q.delete(id); },
    flush: () => { const fns = [...q.values()]; q.clear(); fns.forEach((f) => f()); },
    size: () => q.size,
  };
}

test('建立时就放进 body：读屏用的 polite status 区，视觉隐藏', () => {
  const doc = fakeDoc();
  const a = createAnnouncer(doc, fakeTimers());
  assert.equal(doc.body.children.length, 1);
  assert.equal(doc.body.children[0], a.region);
  assert.equal(a.region.attrs.role, 'status');
  assert.equal(a.region.attrs['aria-live'], 'polite');
  assert.equal(a.region.className, 'sr-only live-region');
  assert.equal(a.region.textContent, '');
});

test('say：先清空、稍后才放文字（同一句连说两次也会再念）', () => {
  const doc = fakeDoc(); const t = fakeTimers();
  const a = createAnnouncer(doc, t);
  a.say('已储存');
  assert.equal(a.region.textContent, '');
  t.flush();
  assert.equal(a.region.textContent, '已储存');
  a.say('已储存');
  assert.equal(a.region.textContent, '', '第二次要先清空，内容变动才会再念');
  t.flush();
  assert.equal(a.region.textContent, '已储存');
});

test('连说两句：只念最后一句（前一个计时被取消）', () => {
  const doc = fakeDoc(); const t = fakeTimers();
  const a = createAnnouncer(doc, t);
  a.say('甲');
  a.say('乙');
  assert.equal(t.size(), 1);
  t.flush();
  assert.equal(a.region.textContent, '乙');
});

test('region 被移出页面后，say 会补回 body', () => {
  const doc = fakeDoc(); const t = fakeTimers();
  const a = createAnnouncer(doc, t);
  a.region.isConnected = false;
  doc.body.children = [];
  a.say('已储存');
  assert.equal(doc.body.children[0], a.region);
  t.flush();
  assert.equal(a.region.textContent, '已储存');
});

test('念完几秒后清空：读屏滑到页尾不会摸到残留的「已储存」', () => {
  const doc = fakeDoc(); const t = fakeTimers();
  const a = createAnnouncer(doc, t);
  a.say('已储存');
  t.flush(); // 放文字，同时排好清空
  assert.equal(a.region.textContent, '已储存');
  assert.ok(t.delays[1] >= 3000, '清空不能太快，免得打断朗读');
  t.flush();
  assert.equal(a.region.textContent, '');
});

test('清空排好之后又说一句：旧的清空被取消，新的一句照常放', () => {
  const doc = fakeDoc(); const t = fakeTimers();
  const a = createAnnouncer(doc, t);
  a.say('甲'); t.flush(); // 现在排着「清空」
  a.say('乙');
  assert.equal(t.size(), 1, '旧的清空要取消');
  t.flush();
  assert.equal(a.region.textContent, '乙');
});

test('Node 环境（没有 document）可以载入 announce.js，announce() 不会丢错', async () => {
  const { announce } = await import('../js/ui/announce.js');
  assert.equal(typeof document, 'undefined');
  assert.doesNotThrow(() => announce('已储存'));
});

test('initAnnouncer 重复呼叫只建一个朗读区', async () => {
  const doc = fakeDoc();
  globalThis.document = doc;
  try {
    const { initAnnouncer, announce } = await import('../js/ui/announce.js?single');
    initAnnouncer(); initAnnouncer(); announce('已储存');
    assert.equal(doc.body.children.length, 1);
  } finally { delete globalThis.document; }
});

test('朗读区固定在左上角（挂在 body 末尾不能撑出 1px 可滚动高度）', async () => {
  const { css } = await import('./helpers/css-tokens.js');
  assert.match(css, /\.live-region\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0;[^}]*left:\s*0;/);
});

test('接线：app 启动时建立朗读区，储存成功关面板后念「已储存」', () => {
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /initAnnouncer\(\)/);
  const entry = readFileSync(new URL('../js/ui/entry-sheet.js', import.meta.url), 'utf8');
  // 成功路径：关面板之后，等退场与首页重画完（whenIdle）才念；失败路径在这之前就 return 了
  const save = entry.slice(entry.indexOf('async function save()'), entry.indexOf('async function confirmDelete()'));
  assert.match(save, /sheet\.close\(\);\s*(?:\/\/[^\n]*\n\s*)*whenIdle\(\(\) => announce\('已储存'\)\);/);
  assert.equal(save.match(/announce\(/g).length, 1, '只在成功路径念一次');
  const catchBlock = save.slice(save.indexOf('} catch (e) {'), save.indexOf('is-saving'));
  assert.ok(!catchBlock.includes('announce'), '储存失败不念');
});
