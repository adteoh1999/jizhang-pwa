// 3c-2 接线：tg-chrome 装在哪、谁呼叫 setPageBack／haptic、CSS 安全区、SW 保护。
// Node 里没有 DOM，挂载类的检查在无头 Chrome 做；这里锁住接线点（每条都做过变异检查）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, namesAndValues } from './helpers/css-tokens.js';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// 去掉 // 注释（行尾注释也去；网址里的 // 前面是冒号，不会被误删）
const code = (p) => src(p).replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------- CSS：安全区 ----------
test('CSS：--safe-* = max(env(safe-area-inset-*), var(--jz-inset-*, 0px))（PWA 没有 --jz-inset-* → 跟原本一样）', () => {
  const at = css.indexOf('--safe-top:');
  assert.ok(at > 0, '找不到 --safe-top 定义');
  const v = namesAndValues(blockAfter(css, ':root {', css.lastIndexOf(':root {', at)));
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.equal(v[`--safe-${side}`], `max(env(safe-area-inset-${side}, 0px), var(--jz-inset-${side}, 0px))`, side);
  }
});

// ---------- app.js ----------
test('app.js：SDK 一载完（detectTelegram 回来）就装 tg-chrome，不等资料库；注入 nav', () => {
  const s = code('js/app.js');
  assert.match(s, /import \{ installTgChrome, setPageBack \} from '\.\/tg-chrome\.js';/);
  assert.match(s, /Promise\.all\(\[openDatabase\(\), detectTelegram\(\)\.then\(\(t\) => \{[^}]*t\.mode === 'telegram'[^}]*installTgChrome\(t\.webApp, \{ nav: \{ depth, canPop, popLayer, onDepthChange \} \}\)/);
  assert.match(s, /import \{ onDepthChange, depth, canPop, popLayer \} from '\.\/ui\/nav\.js';/);
});

test('app.js：Service Worker 先检查支援、注册整段 try（iOS Telegram 没有 SW 时直接略过）', () => {
  const s = code('js/app.js');
  const fn = s.slice(s.indexOf('async function registerServiceWorker'), s.indexOf('async function boot()'));
  assert.match(fn, /^async function registerServiceWorker\(\) \{\s*if \(!\('serviceWorker' in navigator\)\) return;/);
  assert.match(fn, /try \{[\s\S]*sw\.register\('sw\.js'[\s\S]*\} catch \(err\) \{/);
});

test('app.js：initData 过期挡画面先清掉返回键', () => {
  const s = code('js/app.js');
  assert.match(s, /const stale = \(\) => \{\s*setPageBack\(null\);\s*renderFatal\(root,/);
});

test('app.js：切换分页不震（导航不是选择改变，HIG；审核 S14）', () => {
  const s = code('js/app.js');
  const a = s.indexOf('onSelect(id) {');
  const b = s.indexOf('onDepthChange((d) =>', a);
  assert.ok(a >= 0 && b > a, '找不到分页 onSelect 的范围（锚点改名了？）');
  assert.doesNotMatch(s.slice(a, b), /haptic\(/);
});

// ---------- dialogs.js ----------
test('「正在…」遮罩是 locked 层（返回键不出现）', () => {
  assert.match(code('js/ui/dialogs.js'), /pushLayer\(\{ element: overlay, onDismiss: \(\) => \{\}, locked: true \}\)/);
});

// ---------- login.js ----------
test('登录页：只有邮箱／验证码步骤给返回键；用固定函数、步骤变了才呼叫；destroy 只清自己的', () => {
  const s = code('js/ui/login.js');
  assert.match(s, /import \{ setPageBack, clearPageBack \} from '\.\.\/tg-chrome\.js';/);
  assert.match(s, /const tgBack = \(\) => flow\.back\(\);/);
  assert.match(s, /if \(s\.step !== backStep\) \{\s*backStep = s\.step;\s*if \(s\.step === 'email' \|\| s\.step === 'code'\) setPageBack\(tgBack\);\s*else clearPageBack\(tgBack\);\s*\}/);
  const d = s.slice(s.indexOf('function destroy()'));
  assert.match(d, /clearPageBack\(tgBack\);/);
});

test('登录页：initData 过期时先 destroy 自己再交给 onInitStale（停计时器、清返回键）', () => {
  const s = code('js/ui/login.js');
  assert.match(s, /telegram: telegram && \{ \.\.\.telegram, onInitStale: \(\) => \{ destroy\(\); telegram\.onInitStale\(\); \} \}/);
});

// ---------- 震动 ----------
test('分段控件：使用者改变值（change）才震 selection；set() 不震', () => {
  const s = code('js/ui/components.js');
  assert.match(s, /import \{ haptic \} from '\.\.\/tg-chrome\.js';/);
  const changes = [...s.matchAll(/function change\((\w+)\) \{([\s\S]*?)\n {2}\}/g)];
  assert.equal(changes.length, 2);
  for (const [, , body] of changes) assert.match(body, /if \(\w+ === current\) return;[\s\S]*haptic\('selection'\);/);
  const at = s.indexOf('set(v) {');
  assert.ok(at >= 0, '找不到 set(v)');
  assert.doesNotMatch(s.slice(at, s.indexOf('}', at)), /haptic/);
});

test('首页「记一笔」：先同步打开面板、之后才震 light（iOS 才弹键盘）', () => {
  const s = code('js/ui/home.js');
  assert.match(s, /openEntrySheet\(store, \{ onAddCategory \}\); haptic\('light'\);/);
});

test('记一笔面板：储存成功震 success；栏位检查不过、储存失败、删除失败震 error', () => {
  const s = code('js/ui/entry-sheet.js');
  const save = s.slice(s.indexOf('async function save()'), s.indexOf('async function confirmDelete()'));
  assert.match(save, /if \(bad\) \{ showError\(bad\.field, bad\.message\); haptic\('error'\); return; \}/);
  // 震动是装饰：放在状态复位（saving、按钮、标记）之后，万一出事也不会卡住面板（代码审核 r1）
  assert.match(save, /\} catch \(e\) \{\s*saving = false;\s*sheet\.rightButton\.disabled = false;\s*unmarkSaved\(id\);\s*haptic\('error'\);/);
  assert.match(save, /haptic\('success'\);\s*sheet\.panel\.classList\.add\('is-saving'\);/);
  const del = s.slice(s.indexOf('async function confirmDelete()'));
  assert.match(del, /haptic\('error'\);\s*messageDialog\(\{ title: '删除失败'/);
});
