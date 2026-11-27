// B 改版（2026-11-27）中性元件：分类图示单色线条（不要彩色圆圈）、iOS 原生分段控件、次要按钮、单色统计条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

const rules = (src = css) => [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const bodyOf = (sel) => {
  const hit = rules().filter((r) => r.sel.split(',').map((s) => s.trim()).includes(sel));
  assert.ok(hit.length, `missing rule ${sel}`);
  return hit.map((r) => r.body).join('\n');
};

test('彩色分类系统拿掉：没有 [data-icon="…"] 配色规则，也没有 --cat-* token', () => {
  assert.ok(!/\[data-icon="/.test(css), '还有 [data-icon="…"] 配色规则');
  assert.ok(!/--cat-(bg|fg|ink)/.test(css), '还有 --cat-* token');
});

test('图示 token：--icon-ink、--icon-line、--seg-thumb、--bar、--accent-text、--btn2-bg、--btn2-edge 在三块都有', () => {
  for (const t of [light, mediaDark, attrDark]) {
    for (const n of ['--icon-ink', '--icon-line', '--seg-thumb', '--seg-shadow', '--bar', '--accent-text', '--btn2-bg', '--btn2-edge']) assert.ok(t[n], `missing ${n}`);
  }
  assert.equal(light['--accent-text'], '#098354');
  assert.equal(attrDark['--accent-text'], '#4FC08D');
  assert.equal(light['--icon-ink'], '#2F3431');
});

test('列表、统计、记一笔、欢迎页的分类图示：12px 圆角、透明底、淡框、单色字形', () => {
  const box = bodyOf('.home-row-icon');
  assert.match(box, /border-radius:\s*12px/);
  assert.match(box, /background:\s*transparent/);
  assert.match(box, /box-shadow:\s*inset 0 0 0 1px var\(--icon-line\)/);
  assert.match(box, /color:\s*var\(--icon-ink\)/);
  for (const sel of ['.cat-tile-icon', '.wl-tx-ic']) {
    const b = bodyOf(sel);
    assert.match(b, /border-radius:\s*12px/, sel);
    assert.match(b, /var\(--icon-line\)/, sel);
    assert.match(b, /var\(--icon-ink\)/, sel);
    assert.ok(!/50%/.test(b), `${sel} 不再是圆圈`);
  }
  assert.match(bodyOf('.home-row .home-row-icon'), /width:\s*40px/);
});

test('已删除／未分类／新增格：灰实心底＋次要色字形（看得出来，不是 --ink-3）', () => {
  for (const sel of ['.home-row-icon.is-muted', '.cat-tile.is-deleted .cat-tile-icon']) {
    const b = bodyOf(sel);
    assert.match(b, /color:\s*var\(--ink-2\)/, sel);
    assert.match(b, /background:\s*var\(--fill\)/, sel);
  }
});

test('记一笔选中的分类：实心深绿、白字形、没有外框', () => {
  const b = bodyOf('.cat-tile[aria-pressed="true"] .cat-tile-icon');
  assert.match(b, /background:\s*var\(--btn-bg\)/);
  assert.match(b, /color:\s*var\(--btn-fg\)/);
  assert.match(b, /box-shadow:\s*none/);
  assert.ok(!/filter/.test(bodyOf('.cat-tile:active .cat-tile-icon')), '按压不用 filter（透明底上看不出）');
});

test('分段控件：iOS 原生（--seg-track 轨道＋白滑块），不再用深绿；高对比时加框', () => {
  const seg = blockAfter(css, '\n.segmented {');
  assert.match(seg, /background:\s*var\(--seg-track\)/);
  const thumb = blockAfter(css, '\n.segmented::before {');
  assert.match(thumb, /background:\s*var\(--seg-thumb\)/);
  assert.match(thumb, /box-shadow:\s*var\(--seg-shadow\)/);
  assert.match(bodyOf('.segment[aria-checked="true"]'), /color:\s*var\(--ink\)/);
  for (const r of rules().filter((x) => /segment/.test(x.sel))) assert.ok(!/var\(--btn-bg\)|var\(--btn-fg\)/.test(r.body), r.sel);
  const marker = '@media (prefers-contrast: more) {';
  let hc = '';
  for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) hc += blockAfter(css, marker, i) + '\n';
  assert.match(hc, /\.segmented::before \{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--ink-2\)/);
});

test('首页「记一笔」：次要按钮（白底淡框），只有「＋」是深绿', () => {
  const add = blockAfter(css, '\n.home-add {');
  assert.match(add, /background:\s*var\(--btn2-bg\)/);
  assert.match(add, /color:\s*var\(--ink\)/);
  assert.match(add, /box-shadow:\s*0 0 0 1px var\(--btn2-edge\)/);
  assert.match(bodyOf('.home-add svg'), /color:\s*var\(--accent-text\)/);
});

test('「储存」深绿字，且写在 :disabled 之前（同优先级，禁用时才会变灰）', () => {
  const bold = css.indexOf('\n.modal-sheet-action.is-bold {');
  const dis = css.indexOf('\n.modal-sheet-action:disabled {');
  assert.ok(bold >= 0 && dis >= 0, 'both rules exist');
  assert.ok(bold < dis, '.is-bold 要在 :disabled 之前');
  assert.match(bodyOf('.modal-sheet-action.is-bold'), /color:\s*var\(--accent-text\)/);
});

test('统计分类条：单色 --bar、6px；百分比是纯灰字（没有胶囊底）', () => {
  assert.match(blockAfter(css, '\n.stats-bar {'), /height:\s*6px/);
  assert.match(blockAfter(css, '\n.stats-bar-fill {'), /background:\s*var\(--bar\)/);
  assert.match(blockAfter(css, '\n.stats-bar-fill::before {'), /background:\s*var\(--bar\)/);
  const pct = blockAfter(css, '\n.stats-row-pct {');
  assert.ok(!/background/.test(pct), '百分比没有底色');
  assert.match(pct, /color:\s*var\(--ink-2\)/);
  assert.ok(!css.includes('--bar-fade'), '--bar-fade 不再用');
});

test('设置等分组卡：淡框用 --hairline（不另设 --group-edge）', () => {
  assert.match(blockAfter(css, '\n.inset-group {'), /box-shadow:\s*0 0 0 1px var\(--hairline\)/);
  assert.ok(!css.includes('--group-edge'));
});
