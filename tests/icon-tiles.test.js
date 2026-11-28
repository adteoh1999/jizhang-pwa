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

test('图示 token：--icon-ink、--icon-line、--seg-thumb、--bar-from／--bar-to、--accent-text、--btn2-bg、--btn2-edge 在三块都有', () => {
  for (const t of [light, mediaDark, attrDark]) {
    for (const n of ['--icon-ink', '--icon-line', '--seg-thumb', '--seg-shadow', '--bar-from', '--bar-to', '--accent-text', '--btn2-bg', '--btn2-edge']) assert.ok(t[n], `missing ${n}`);
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
  assert.ok(!/filter/.test(bodyOf('.cat-tile:not([aria-pressed="true"]):active .cat-tile-icon')), '按压不用 filter（透明底上看不出）');
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

test('统计分类条：8px、全圆角（v3.7 每条金头绿尾，见 meter-gradient 测试）；百分比是纯灰字（没有胶囊底）', () => {
  const bar = blockAfter(css, '\n.stats-bar {');
  assert.match(bar, /height:\s*8px/);
  assert.match(bar, /border-radius:\s*4px/);
  const fill = blockAfter(css, '\n.stats-bar-fill {');
  assert.match(fill, /border-radius:\s*0 4px 4px 0/);
  assert.match(fill, /box-shadow:\s*inset 0 1px 0 rgba\(255, 255, 255, 0\.22\)/);
  assert.match(blockAfter(css, '\n.stats-bar-fill::before {'), /box-shadow:\s*inset 0 1px 0 rgba\(255, 255, 255, 0\.22\)/);
  const pct = blockAfter(css, '\n.stats-row-pct {');
  assert.ok(!/background/.test(pct), '百分比没有底色');
  assert.match(pct, /color:\s*var\(--ink-2\)/);
  assert.ok(!css.includes('--bar-fade'), '--bar-fade 不再用');
});

test('设置等分组卡：淡框用 --hairline（不另设 --group-edge）', () => {
  assert.match(blockAfter(css, '\n.inset-group {'), /box-shadow:\s*0 0 0 1px var\(--hairline\)/);
  assert.ok(!css.includes('--group-edge'));
});

// ---------- 最终审核修正（2026-11-27） ----------
const tokensOf = { light, dark: { ...light, ...attrDark } };
function col(theme, name, depth = 0) {
  const v = tokensOf[theme][name];
  assert.ok(v !== undefined && depth < 10, `token ${name} (${theme})`);
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) return col(theme, ref[1], depth + 1);
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = v.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, `unparseable ${v}`);
  const p = m[1].split(',').map(parseFloat);
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
}
const mix = (bg, c) => bg.map((x, i) => c.rgb[i] * c.a + x * (1 - c.a));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)]; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

// I-1：深色模式滑块要看得出来（iOS 原生深色滑块约 #636366）；浅色靠白滑块＋阴影，与 iOS 原生相当
for (const [theme, min] of [['light', 1.08], ['dark', 1.5]]) {
  for (const bg of ['--drawer', '--sky-top', '--sky-mid', '--sky-low', '--sky-bottom']) {
    test(`${theme} 分段控件滑块对「${bg}＋轨道」≥ ${min}（看得出选了哪个）`, () => {
      const track = mix(col(theme, bg).rgb, col(theme, '--seg-track'));
      const thumb = mix(track, col(theme, '--seg-thumb'));
      const r = ratio(thumb, track);
      assert.ok(r >= min, `${r.toFixed(2)} < ${min}`);
    });
  }
}

const posOf = (sel) => { const i = css.indexOf(`\n${sel} {`); assert.ok(i >= 0, `missing ${sel}`); return i; };

test('I-2：已删除的分类被选中（编辑旧记录）仍显示实心深绿，规则在「已删除」之后', () => {
  const sel = '.cat-tile.is-deleted[aria-pressed="true"] .cat-tile-icon';
  const at = posOf(sel);
  assert.ok(at > css.indexOf('\n.cat-tile.is-deleted .cat-tile-icon'), '要写在 .is-deleted 规则之后');
  const b = blockAfter(css, `\n${sel} {`);
  assert.match(b, /background:\s*var\(--btn-bg\)/);
  assert.match(b, /color:\s*var\(--btn-fg\)/);
});

test('M-1：按压回馈只给没选中的格（选中的白字形不会被浅色底吃掉）', () => {
  assert.ok(!css.includes('\n.cat-tile:active .cat-tile-icon {'), '旧的按压规则会盖掉选中的深绿底');
  assert.match(blockAfter(css, '\n.cat-tile:not([aria-pressed="true"]):active .cat-tile-icon {'), /background:\s*var\(--press-bg\)/);
  assert.match(blockAfter(css, '\n.cat-tile[aria-pressed="true"]:active .cat-tile-icon {'), /opacity:\s*0\.7/);
});

// M-2／M-3：高对比的加框规则必须排在被覆盖的基础规则之后（同优先级靠文件顺序）
test('M-2／M-3：增加对比度时，图示框、白面板、深绿卡都加实线边，且规则排在基础规则之后', () => {
  const marker = '@media (prefers-contrast: more) {';
  const blocks = [];
  for (let i = css.indexOf(marker); i >= 0; i = css.indexOf(marker, i + 1)) blocks.push({ at: i, body: blockAfter(css, marker, i) });
  const find = (selRe, declRe) => blocks.find((b) => [...b.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .some((m) => selRe.test(m[1]) && declRe.test(m[2])));
  for (const [sel, base] of [['.wl-tx-ic', '\n.wl-tx-ic {'], ['.home-add', '\n.home-add {'], ['.trend-card', '\n.trend-card {'], ['.inset-group', '\n.inset-group {']]) {
    const esc = sel.replace(/[.]/g, '\\.');
    const b = find(new RegExp(`(^|,|\\s)${esc}(\\s|,|$)`), /0 0 0 1px var\(--ink-2\)/);
    assert.ok(b, `${sel} 高对比加框`);
    assert.ok(b.at > css.indexOf(base), `${sel} 的高对比规则要在基础规则之后`);
  }
  assert.ok(find(/\.home-card/, /0 0 0 1px var\(--card-ink-2\)/), '深绿卡高对比加一圈');
});
