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

// 整页晨雾：.sky、子页面、阻挡画面共用同一条规则（一条连续渐变，顶端 sky-top）
const MIST_RULE = '\n.sky,\n.nav-page,\n.overlay.overlay-blocking {';
const MIST_GRADIENT = 'linear-gradient(180deg, var(--sky-top) 0%, var(--sky-mid) 30%, var(--sky-low) 65%, var(--sky-bottom) 100%)';

test('status bar seam: every full-screen top layer has sky-top as background-color (iOS 26 samples it)', () => {
  const body = blockAfter(css, MIST_RULE);
  assert.match(body, /background-color:\s*var\(--sky-top\)/);
  assert.ok(body.includes(`background-image: ${MIST_GRADIENT};`), 'one continuous mist gradient');
  // 子页面与阻挡画面自己的规则不能再另设背景（否则会盖掉共用的渐变）
  assert.ok(!/background/.test(blockAfter(css, '\n.nav-page {')));
  assert.ok(!/background/.test(blockAfter(css, '\n.overlay-blocking {')));
});

test('mist background has no clouds or fade band (no blocks, no seams)', () => {
  assert.ok(!/\.sky::before/.test(css));
  assert.ok(!/radial-gradient/.test(blockAfter(css, '\n.sky {')));
  for (const gone of ['--cloud', '--cloud-soft', '--sky-hi', '--sky-tint', '--halo-opacity', '--halo-pink', '--halo-mint']) {
    assert.ok(!(gone in light), gone);
    assert.ok(!css.includes(`var(${gone})`), `still used: ${gone}`);
  }
});

const hexRgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16)).join(', ');

test('nav bar material and the opaque fallbacks equal sky-top', () => {
  assert.equal(light['--bar-material'], `rgba(${hexRgb(light['--sky-top'])}, 0.94)`);
  assert.equal(attrDark['--bar-material'], `rgba(${hexRgb(attrDark['--sky-top'])}, 0.94)`);
  const fallbacks = [...css.matchAll(/--bar-material: (#[0-9A-F]{6});/gi)].map((m) => m[1]);
  assert.deepEqual(fallbacks, [light['--sky-top'], attrDark['--sky-top'], attrDark['--sky-top']]);
});

test('spec colors are used verbatim', () => {
  assert.equal(light['--sky-top'], '#CFE3EF');
  assert.equal(light['--sky-mid'], '#D4EAEE');
  assert.equal(light['--sky-low'], '#D9F0E8');
  assert.equal(light['--sky-bottom'], '#E4F6EE');
  assert.equal(attrDark['--sky-top'], '#132230');
  assert.equal(attrDark['--sky-mid'], '#11232A');
  assert.equal(attrDark['--sky-low'], '#0F2222');
  assert.equal(attrDark['--sky-bottom'], '#0B1A17');
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
  assert.equal(man.background_color, light['--sky-top']);   // 启动画面＝天空顶端色，与状态栏、body 相同
  assert.equal(man.theme_color, light['--sky-top']);
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.ok(html.includes(`<meta name="theme-color" content="${light['--sky-top']}" media="(prefers-color-scheme: light)">`));
  assert.ok(html.includes(`<meta name="theme-color" content="${attrDark['--sky-top']}" media="(prefers-color-scheme: dark)">`));
});

test('app.js prepends the .sky layer', () => {
  const js = readFileSync(new URL('js/app.js', root), 'utf8');
  assert.match(js, /document\.body\.prepend\(h\('div', \{ class: 'sky'/);
});
