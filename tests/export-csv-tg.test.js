// 3c-2 第 5 项：Telegram 里导出 CSV——先试分享，不行就提示「请用浏览器导出」，绝不走下载（用户 2026-11-26 决定）。
// PWA 照旧：分享不行就下载。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createExporter, canShareCsv, TG_EXPORT_TEXT, TG_EXPORT_SWITCH_TEXT, TG_EXPORT_SIGNOUT_TEXT } from '../js/ui/export-csv.js';
import { installTgChrome, _resetTgChrome } from '../js/tg-chrome.js';

const store = (n = 2) => ({ transactions: () => Array(n).fill({}), exportCSV: () => '﻿日期,金额\n' });
const doc = () => ({ visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig({ inTelegram, canShare = false, share, n = 2, canShareThrows = false, tgFallback, now } = {}) {
  const saved = [];
  const notes = [];
  const shared = [];
  const nav = {
    canShare: canShareThrows ? () => { throw new TypeError('files'); } : () => canShare,
    share: (data) => { shared.push(data); return share ? share(data) : Promise.resolve(); },
  };
  const exportCsv = createExporter(store(n), {
    nav, doc: doc(), save: (f) => saved.push(f), notify: (o) => notes.push(o), inTelegram: () => inTelegram,
    ...(tgFallback ? { tgFallback } : {}), ...(now ? { now } : {}),
  });
  return { exportCsv, saved, notes, shared };
}


test('PWA：不能分享 → 下载（照旧）', () => {
  const r = rig({ inTelegram: false });
  r.exportCsv();
  assert.equal(r.saved.length, 1);
  assert.equal(r.notes.length, 0);
});

test('PWA：分享失败（不是取消）→ 下载（照旧）', async () => {
  const r = rig({ inTelegram: false, canShare: true, share: () => Promise.reject(new Error('x')) });
  r.exportCsv();
  await tick();
  assert.equal(r.saved.length, 1);
  assert.equal(r.notes.length, 0);
});

test('Telegram：不能分享 → 提示用浏览器导出，不下载', () => {
  const r = rig({ inTelegram: true });
  r.exportCsv();
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.notes, [TG_EXPORT_TEXT]);
});

test('Telegram：canShare 丢错 → 当不能分享 → 提示', () => {
  const r = rig({ inTelegram: true, canShareThrows: true });
  r.exportCsv();
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.notes, [TG_EXPORT_TEXT]);
});

test('Telegram：能分享 → 分享 CSV 档，不提示不下载', async () => {
  const r = rig({ inTelegram: true, canShare: true });
  r.exportCsv();
  await tick();
  assert.equal(r.shared.length, 1);
  assert.match(r.shared[0].files[0].name, /^jizhang-\d{8}\.csv$/);
  assert.equal(r.saved.length + r.notes.length, 0);
});

test('Telegram：分享失败（不是取消）→ 提示，不下载', async () => {
  const e = new Error('not allowed');
  e.name = 'NotAllowedError';
  const r = rig({ inTelegram: true, canShare: true, share: () => Promise.reject(e) });
  r.exportCsv();
  await tick();
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.notes, [TG_EXPORT_TEXT]);
});

test('Telegram：分享时同步丢错 → 提示，不下载', () => {
  const r = rig({ inTelegram: true, canShare: true, share: () => { throw new Error('sync'); } });
  r.exportCsv();
  assert.equal(r.saved.length, 0);
  assert.deepEqual(r.notes, [TG_EXPORT_TEXT]);
});

test('Telegram：在分享选单按取消（AbortError）→ 什么都不做', async () => {
  const e = new Error('abort');
  e.name = 'AbortError';
  const r = rig({ inTelegram: true, canShare: true, share: () => Promise.reject(e) });
  r.exportCsv();
  await tick();
  assert.equal(r.saved.length + r.notes.length, 0);
});

test('没有记录：两边都只说「没有可导出的记录」', () => {
  for (const inTelegram of [false, true]) {
    const r = rig({ inTelegram, n: 0 });
    r.exportCsv();
    assert.deepEqual(r.notes, [{ title: '没有可导出的记录' }]);
    assert.equal(r.saved.length + r.shared.length, 0);
  }
});

test('提示文字：说清楚去哪里导出，也提醒没同步完的记录要等同步（审核建议 2）', () => {
  assert.equal(TG_EXPORT_TEXT.title, '这里无法导出');
  assert.match(TG_EXPORT_TEXT.message, /jizhang\.adteoh\.com/);
  assert.match(TG_EXPORT_TEXT.message, /设置 › 导出 CSV/);
  assert.match(TG_EXPORT_TEXT.message, /同步/);
});

// ---------- 代码审核 r1（导出）补充 ----------
test('会清资料的对话框（有没上传的记录）：分享不行 → 提示「先取消、等上传完」，不叫人去浏览器（审核必须改 1）', async () => {
  for (const t of [TG_EXPORT_SWITCH_TEXT, TG_EXPORT_SIGNOUT_TEXT]) {
    assert.equal(t.title, '这里无法导出');
    assert.doesNotMatch(t.message, /浏览器/);
    assert.match(t.message, /上传/);
  }
  // 复审建议 1：各自给能做到的下一步——换账号：取消后用原来的账号登录；解除连接：按「先同步」
  assert.match(TG_EXPORT_SWITCH_TEXT.message, /取消后用原来的账号登录/);
  assert.match(TG_EXPORT_SIGNOUT_TEXT.message, /「先同步」/);
  const a = rig({ inTelegram: true, tgFallback: TG_EXPORT_SWITCH_TEXT });
  a.exportCsv();
  assert.deepEqual(a.notes, [TG_EXPORT_SWITCH_TEXT]);
  const e = new Error('x');
  const b = rig({ inTelegram: true, canShare: true, share: () => Promise.reject(e), tgFallback: TG_EXPORT_SIGNOUT_TEXT });
  b.exportCsv();
  await tick();
  assert.deepEqual(b.notes, [TG_EXPORT_SIGNOUT_TEXT]);
  assert.equal(a.saved.length + b.saved.length, 0);
});

test('PWA：给了 tgFallback 也照旧下载（只影响 Telegram）', () => {
  const r = rig({ inTelegram: false, tgFallback: TG_EXPORT_SWITCH_TEXT });
  r.exportCsv();
  assert.equal(r.saved.length, 1);
  assert.equal(r.notes.length, 0);
});

test('分享计时全部用注入的 now（复审建议 4）', () => {
  const src = readFileSync(new URL('../js/ui/export-csv.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function createExporter')), /Date\.now\(\)/);
});

test('分享面板一直没回应：30 秒内再按不重复分享；超过 30 秒再按 → 当上一轮已结束（审核建议 4）', () => {
  const clock = { t: 1_000_000 };
  const r = rig({ inTelegram: true, canShare: true, share: () => new Promise(() => {}), now: () => clock.t });
  r.exportCsv();
  r.exportCsv();
  assert.equal(r.shared.length, 1);
  clock.t += 29_000;
  r.exportCsv();
  assert.equal(r.shared.length, 1);
  clock.t += 2_000;
  r.exportCsv();
  assert.equal(r.shared.length, 2);
});

test('预设的 inTelegram 跟着 tg-chrome：装上后不能分享 → 提示、不下载；拆掉后回到下载', () => {
  const saved = [];
  const notes = [];
  const nav = { canShare: () => false };
  const mk = () => createExporter(store(), { nav, doc: doc(), save: (f) => saved.push(f), notify: (o) => notes.push(o) });
  const navStub = { depth: () => 0, canPop: () => false, popLayer() {}, onDepthChange: () => () => {} };
  try {
    installTgChrome({ colorScheme: 'light' }, { root: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, win: new EventTarget(), nav: navStub, defer: () => {} });
    mk()();
    assert.equal(saved.length, 0);
    assert.deepEqual(notes, [TG_EXPORT_TEXT]);
  } finally {
    _resetTgChrome();
  }
  mk()();
  assert.equal(saved.length, 1);
});

test('canShareCsv：没有 canShare、丢错、回 false → false；回 true → true', () => {
  assert.equal(canShareCsv({ nav: {} }), false);
  assert.equal(canShareCsv({ nav: undefined }), false);
  assert.equal(canShareCsv({ nav: { canShare: () => { throw new Error('x'); } } }), false);
  assert.equal(canShareCsv({ nav: { canShare: () => false } }), false);
  let got = null;
  assert.equal(canShareCsv({ nav: { canShare: (d) => { got = d; return true; } } }), true);
  assert.equal(got.files[0].type, 'text/csv', '用 CSV 档去问');
});

// ---------- 对话框里的「先导出」：Telegram 里能分享才出现 ----------
const code = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('换账号、解除连接的「导出」用「先取消、等上传完」的提示（审核必须改 1）', () => {
  assert.match(code('js/ui/login.js'), /const exportCsv = exportable \? exporter\(store, \{ tgFallback: TG_EXPORT_SWITCH_TEXT \}\) : null;/);
  assert.match(code('js/ui/sign-out.js'), /exportCsv = createExporter\(store, \{ tgFallback: TG_EXPORT_SIGNOUT_TEXT \}\),/);
});

test('换账号（登录页、Telegram 启动）、Mini App 解除连接：Telegram 里能分享才给「先导出」', () => {
  assert.match(code('js/ui/login.js'), /confirmReset: \(info\) => askReset\(store, info, \{ exportable: !telegram \|\| canShareCsv\(\) \}\)/);
  assert.match(code('js/app.js'), /askReset: \(info\) => askReset\(store, info, \{ exportable: canShareCsv\(\) \}\)/);
  assert.match(code('js/ui/tg-unlink.js'), /exportable: canShareCsv\(\),/);
});
