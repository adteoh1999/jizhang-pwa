import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { css, blockAfter, namesAndValues, light, mediaDark, attrDark } from './helpers/css-tokens.js';

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

test('--spring：基础值是后备，@supports linear() 区块等于 motion.js 算出的字串；没有 --spring-sheet', async () => {
  const { SPRING, SPRING_FALLBACK } = await import('../js/ui/motion.js');
  const base = namesAndValues(blockAfter(css, ':root {', css.lastIndexOf(':root {', css.indexOf('--ease-out'))));
  assert.equal(base['--spring'], SPRING_FALLBACK);
  assert.ok(!css.includes('--spring-sheet'), '--spring-sheet 已删除');
  assert.equal(base['--sheet-in-dur'], '0.32s');
  assert.equal(base['--sheet-in-ease'], 'cubic-bezier(0.2, 0.8, 0.2, 1)');
  const sup = blockAfter(css, '@supports (transition-timing-function: linear(0, 1))');
  const v = namesAndValues(blockAfter(sup, ':root {'));
  assert.equal(v['--spring'], SPRING);
  assert.ok(css.indexOf('--ease-out') >= 0);
  assert.ok(css.indexOf('@supports (transition-timing-function: linear(0, 1))') > css.indexOf('--ease-out'),
    '@supports 要放在第一个 :root 之后');
});

test('JS 也不能用 will-change', () => {
  const dir = new URL('js/', root);
  const walk = (u) => readdirSync(u, { withFileTypes: true }).flatMap((d) => (d.isDirectory()
    ? walk(new URL(`${d.name}/`, u)) : d.name.endsWith('.js') ? [new URL(d.name, u)] : []));
  for (const f of walk(dir)) assert.ok(!/will-?change/i.test(readFileSync(f, 'utf8')), f.pathname);
});

test('标签栏胶囊 0.25s、图示 0.2s，回弹用 var(--spring)', () => {
  assert.match(blockAfter(css, '\n.tabbar-pill {'), /transition:\s*transform 0\.25s var\(--spring\)/);
  assert.match(blockAfter(css, '\n.tabbar-item svg {'), /transition:\s*transform 0\.2s var\(--spring\)/);
});

test('v2.3.1 时长：面板退场 0.25s、遮罩 0.2s、toast 0.2s、action sheet 0.25s、子页面 0.25s、列左滑 0.2s', () => {
  assert.match(blockAfter(css, '\n.modal-sheet {'), /transition:\s*transform 0\.25s var\(--ease-out\)/);
  assert.match(blockAfter(css, '\n.overlay {'), /transition:\s*opacity 0\.2s ease/);
  assert.match(blockAfter(css, '\n.toast {'), /transition:\s*opacity 0\.2s ease, transform 0\.2s var\(--ease-out\)/);
  assert.match(blockAfter(css, '\n.action-sheet {'), /transition:\s*transform 0\.25s var\(--ease-out\)/);
  assert.match(blockAfter(css, '\n.nav-page {'), /transition:\s*transform 0\.25s var\(--ease-out\)/);
  assert.match(css, /\.home-row-content\.is-animating \{ transition: transform 0\.2s var\(--ease-out\); \}/);
  assert.match(css, /\.home-row-delete\.is-animating \{ transition: width 0\.2s var\(--ease-out\); \}/);
  const sheet = readFileSync(new URL('js/ui/sheet.js', root), 'utf8');
  assert.match(sheet, /setTimeout\(endEntering, 450\)/);
  assert.match(sheet, /setTimeout\(remove, 350\)/);
});

test('数字滚轮：容器裁切、行高等于格高，非数字段保留空格', () => {
  const roll = blockAfter(css, '\n.roll {');
  assert.match(roll, /overflow-y:\s*clip/);   // 只裁上下
  assert.match(roll, /overflow-x:\s*visible/);
  assert.match(roll, /line-height:\s*var\(--roll-h\)/);
  assert.match(blockAfter(css, '\n.roll > span {'), /white-space:\s*pre/);
});

test('记一笔面板：进场用 --sheet-in-dur / --sheet-in-ease（只在 is-entering），减弱动态用同一个选择器关掉，不再有实色延伸', () => {
  const SEL = '.overlay-modal.is-visible .modal-sheet.is-entering {';
  assert.match(blockAfter(css, '\n' + SEL), /transition:\s*transform var\(--sheet-in-dur\) var\(--sheet-in-ease\)/);
  const rm = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)].map((m) => blockAfter(css, '@media (prefers-reduced-motion: reduce)', m.index));
  // 只看那条规则自己的 {…}（同一区块后面别的 transition: none 不算）
  const own = (b) => { const i = b.indexOf(SEL.slice(0, -2)); return b.slice(i, b.indexOf('}', i)); };
  assert.ok(rm.some((b) => b.includes(SEL.slice(0, -2)) && /transition:\s*none/.test(own(b))), '减弱动态要盖过进场规则');
  assert.ok(!/0 40px 0 0 var\(--drawer\)/.test(blockAfter(css, '\n.modal-sheet {')), '不回弹就不需要底部实色延伸');
});

test('sheet.js / entry-sheet.js：退场登记、分类轻弹；不再有储存变勾（v2.3.1）', () => {
  const sheet = readFileSync(new URL('js/ui/sheet.js', root), 'utf8');
  assert.match(sheet, /trackExit\(/);
  assert.match(sheet, /is-entering/);
  const entry = readFileSync(new URL('js/ui/entry-sheet.js', root), 'utf8');
  assert.match(entry, /scale\(0\.8\)/);
  assert.ok(!/icon\('check'/.test(entry), '不再有 ✓');
  assert.ok(!/showSaved\(/.test(entry), '不再有 showSaved');
  assert.ok(!/DUR\.check/.test(entry), '不再等 ✓');
  assert.ok(!/modal-sheet-check|modal-sheet-saved-text|is-saved/.test(css), '只为 ✓ 的 CSS 已删');
});

test('记一笔：存好马上关（中间不能等）', () => {
  const enterIdx = css.indexOf('\n.overlay-modal.is-visible .modal-sheet.is-entering {');
  const rmIdx = css.lastIndexOf('.overlay-modal.is-visible .modal-sheet.is-entering');
  assert.ok(enterIdx >= 0 && rmIdx > enterIdx + 1, '减弱动态规则要写在进场规则之后（且两条都存在）');
  const entry = readFileSync(new URL('js/ui/entry-sheet.js', root), 'utf8');
  const save = entry.slice(entry.indexOf('async function save('), entry.indexOf('async function confirmDelete('));
  // 存好就马上关：saveTransaction 之后、close() 之前不能再 await；is-saving 在 close 之前加上
  const iSave = save.indexOf('saveTransaction(');
  const iSaving = save.indexOf("classList.add('is-saving')");
  const iClose = save.indexOf('sheet.close()');
  assert.ok(iSave >= 0 && iSaving > iSave && iClose > iSaving, '顺序：存好 → is-saving → close');
  // 存好到关闭之间：不能 await，也不能用计时器 / then 延后关闭（注释里写到这些字会误报，改写时留意）
  const gap = save.slice(save.indexOf(';', iSave), iClose);
  assert.ok(!/await|setTimeout|requestAnimationFrame|\.then\(/.test(gap), '存好到关闭之间不能等');
  assert.equal(entry.split('popSelected(').length - 1, 2, 'popSelected 只有定义与一个呼叫点');
  assert.match(blockAfter(css, '\n.modal-sheet.is-saving .modal-sheet-body {'), /pointer-events:\s*none/);
  const sheet = readFileSync(new URL('js/ui/sheet.js', root), 'utf8');
  assert.ok(!/if \(reducedMotion\(\)\) release\(\)/.test(sheet), '减弱动态不能提早放行（焦点还原之前）');
  assert.ok(sheet.indexOf('overlay.remove(); release();') > 0);
});

test('切换分页：.screens 横向裁切；app.js 对新分页淡入滑动，切到统计页呼叫 enter()', () => {
  assert.match(blockAfter(css, '\n.screens {'), /overflow-x:\s*clip/);
  const app = readFileSync(new URL('js/app.js', root), 'utf8');
  assert.match(app, /translateX\(\$\{dir \* 8\}px\)/);
  assert.match(app, /duration: DUR\.tab, easing: EASE_OUT/);
  assert.match(app, /duration: DUR\.tab/);
  assert.match(app, /id: 'tab'/);
  assert.match(app, /stats\.enter\(\)/);
  const stats = readFileSync(new URL('js/ui/stats-view.js', root), 'utf8');
  assert.match(stats, /return \{ enter/);
});

test('切换分页：动画本身带 id、减弱动态或不支援 overflow clip 时只淡入；方向键按住不重复切', () => {
  const app = readFileSync(new URL('js/app.js', root), 'utf8');
  assert.match(app, /fade\(next, 'in', \{ id: 'tab' \}\)/);
  assert.match(app, /clipSupported\(\)/);
  assert.ok(!/matchMedia\('\(prefers-reduced-motion/.test(app), '统一用 reducedMotion()');
  const tabbar = readFileSync(new URL('js/ui/tabbar.js', root), 'utf8');
  assert.match(tabbar, /e\.repeat/);
});
