import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { css, blockAfter, light, mediaDark, attrDark } from './helpers/css-tokens.js';

const root = new URL('../', import.meta.url);

test('dark tokens are defined identically in both dark blocks', () => {
  assert.ok(Object.keys(attrDark).length > 20);
  assert.deepEqual(mediaDark, attrDark);
});

test('every dark token also exists in the light :root', () => {
  for (const name of Object.keys(attrDark)) assert.ok(light[name] !== undefined, name);
});

test('every literal-colour light token also exists in both dark blocks', () => {
  for (const [name, val] of Object.entries(light)) {
    if (val.startsWith('var(')) continue;
    assert.ok(mediaDark[name] !== undefined, `media dark: ${name}`);
    assert.ok(attrDark[name] !== undefined, `attr dark: ${name}`);
  }
});

test('html rule has no background (body background must propagate under .sky)', () => {
  assert.ok(!/background/.test(blockAfter(css, '\nhtml {')));
  // body 底色＝天空顶端色：iOS 26 取样页面底色给状态栏上色，必须与天空顶端、theme-color 同色
  assert.match(blockAfter(css, '\nbody {'), /background:\s*var\(--sky-top\)/);
});

test('empty 44px nav-bar is gone (titles sit right under the status bar)', () => {
  assert.ok(!/\.nav-bar\b/.test(css));
  assert.ok(!/'nav-bar'/.test(readFileSync(new URL('js/app.js', root), 'utf8')));
});

test('sub-page top matches the status bar (sky-top)', () => {
  assert.match(blockAfter(css, '\n.nav-page {'), /background-color:\s*var\(--sky-top\)/);
});

test('reduced transparency keeps sky-top at the top and hides the fade band', () => {
  assert.match(css, /\.sky \{ background-image: linear-gradient\(var\(--sky-top\), var\(--sky-mid\) 64px\); \}/);
  assert.match(css, /\.sky::before \{ display: none; \}/);
});

test('status bar seam: .sky carries sky-top as background-color and a top fade band', () => {
  assert.match(blockAfter(css, '\n.sky {'), /background-color:\s*var\(--sky-top\)/);
  assert.match(blockAfter(css, '\n.sky::before {'), /linear-gradient\(var\(--sky-top\), transparent\)/);
});

test('spec colors are used verbatim', () => {
  assert.equal(light['--sky-top'], '#D5E0EA');
  assert.equal(light['--sky-mid'], '#E6ECF1');
  assert.equal(light['--sky-low'], '#F1F3F5');
  assert.equal(attrDark['--sky-top'], '#1A2330');
  assert.equal(attrDark['--sky-mid'], '#121820');
  assert.equal(attrDark['--sky-low'], '#0C1015');
  assert.equal(light['--ink'], '#0A0A0B');
  assert.equal(attrDark['--ink'], '#F4F6F8');
  assert.equal(light['--drawer'], '#FFFFFF');
  assert.equal(attrDark['--drawer'], '#1A1D23');
  assert.equal(light['--income'], '#157A35');
  assert.equal(attrDark['--income'], '#4CD07A');
  assert.equal(light['--ink-2'], 'rgba(10, 12, 18, 0.65)');
  assert.equal(attrDark['--ink-2'], 'rgba(235, 240, 248, 0.66)');
});

test('old names are kept as aliases of the new tokens', () => {
  assert.equal(light['--label'], 'var(--ink)');
  for (const gone of ['--accent', '--accent-tint', '--accent-sel', '--green', '--bg-grouped', '--sheet-bg', '--cell-bg']) assert.ok(!(gone in light), gone);
  assert.equal(light['--bg-grouped-secondary'], 'var(--drawer)');
});

test('no blue accent literal remains', () => {
  assert.ok(!/rgb\(0,\s*1[34]\d,\s*255\)/.test(css));
});

function blurSelectors(src) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of src.matchAll(re)) {
    if (/(^|[^-])backdrop-filter\s*:/.test(m[2])) out.push(m[1].trim().split('\n').pop().trim());
  }
  return out;
}
test('backdrop-filter used exactly on the 4 allowed selectors', () => {
  assert.deepEqual(blurSelectors(css).sort(), ['.alert', '.nav-page-bar', '.sheet-group', '.tabbar']);
});

test('no forbidden perf patterns', () => {
  for (const bad of ['filter: blur', 'background-attachment: fixed', 'will-change']) {
    assert.ok(!css.replace(/backdrop-filter: [^;]*/g, '').includes(bad), bad);
  }
});

test('manifest and theme-color use the sky colors', () => {
  const man = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(man.background_color, '#D5E0EA');   // 启动画面＝天空顶端色，与状态栏、body 相同
  assert.equal(man.theme_color, '#D5E0EA');
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(html, /<meta name="theme-color" content="#D5E0EA" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#1A2330" media="\(prefers-color-scheme: dark\)">/);
});

test('app.js prepends the .sky layer', () => {
  const js = readFileSync(new URL('js/app.js', root), 'utf8');
  assert.match(js, /document\.body\.prepend\(h\('div', \{ class: 'sky'/);
});
