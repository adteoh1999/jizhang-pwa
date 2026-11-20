import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('css/app.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 取 `selector {` 之后配对的大括号内容
function blockAfter(src, marker, from = 0) {
  const i = src.indexOf(marker, from);
  assert.ok(i >= 0, `missing ${marker}`);
  let depth = 0;
  const start = src.indexOf('{', i);
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(start + 1, k);
  }
  throw new Error('unbalanced');
}
function namesAndValues(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = namesAndValues(blockAfter(css, ':root {'));
const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const mediaDark = namesAndValues(blockAfter(css, ':root:not([data-theme="light"])', mediaStart));
const attrDark = namesAndValues(blockAfter(css, ':root[data-theme="dark"]'));

test('dark tokens are defined identically in both dark blocks', () => {
  assert.ok(Object.keys(attrDark).length > 20);
  assert.deepEqual(mediaDark, attrDark);
});

test('every dark token also exists in the light :root', () => {
  for (const name of Object.keys(attrDark)) assert.ok(light[name] !== undefined, name);
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
  assert.equal(light['--accent'], 'var(--ink)');
  assert.equal(light['--label'], 'var(--ink)');
  assert.equal(light['--green'], 'var(--income)');
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
// Task 3 拿掉 Toast 的模糊后改回 test
test.todo('backdrop-filter used exactly on the 4 allowed selectors', () => {
  assert.deepEqual(blurSelectors(css).sort(), ['.alert', '.nav-page-bar', '.sheet-group', '.tabbar']);
});

test('no forbidden perf patterns', () => {
  for (const bad of ['filter: blur', 'background-attachment: fixed', 'will-change']) {
    assert.ok(!css.replace(/backdrop-filter: [^;]*/g, '').includes(bad), bad);
  }
});

test('manifest and theme-color use the sky colors', () => {
  const man = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(man.background_color, '#E6ECF1');
  assert.equal(man.theme_color, '#D5E0EA');
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(html, /<meta name="theme-color" content="#D5E0EA" media="\(prefers-color-scheme: light\)">/);
  assert.match(html, /<meta name="theme-color" content="#1A2330" media="\(prefers-color-scheme: dark\)">/);
});

test('app.js prepends the .sky layer', () => {
  const js = readFileSync(new URL('js/app.js', root), 'utf8');
  assert.match(js, /document\.body\.prepend\(h\('div', \{ class: 'sky'/);
});
