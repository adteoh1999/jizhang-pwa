import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATEGORY_ICON_CHOICES } from '../js/ui/icons.js';
import { DEFAULT_CATEGORIES } from '../js/model.js';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('css/app.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 取 `<prefix>[data-icon="n"] { --cat-bg:…; --cat-fg:…; }`
function rule(prefix, n) {
  const re = new RegExp(`(?:^|\\n)[ ]*${esc(prefix)}\\[data-icon="${n}"\\]\\s*\\{([^}]*)\\}`, 'g');
  const hits = [...css.matchAll(re)];
  if (hits.length !== 1) return null;
  const bg = /--cat-bg:\s*([^;]+);/.exec(hits[0][1]);
  const fg = /--cat-fg:\s*([^;]+);/.exec(hits[0][1]);
  return bg && fg ? { bg: bg[1].trim(), fg: fg[1].trim() } : null;
}
const lightRuleFor = (n) => rule('', n);
// 取出所有 `@media (prefers-color-scheme: dark) { … }` 区块（以大括号配对）
function darkMediaBlocks() {
  const out = [];
  let i = 0;
  while ((i = css.indexOf('@media (prefers-color-scheme: dark)', i)) >= 0) {
    const start = css.indexOf('{', i);
    let depth = 0, k = start;
    for (; k < css.length; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}' && --depth === 0) break;
    }
    out.push(css.slice(start, k + 1));
    i = k;
  }
  return out;
}
const mediaWithIcons = darkMediaBlocks().filter((b) => b.includes('[data-icon='));
const darkMedia = (n) => {
  const b = mediaWithIcons.find((x) => x.includes(`:root:not([data-theme="light"]) [data-icon="${n}"]`));
  return b ? rule(':root:not([data-theme="light"]) ', n) : null;
};
const darkAttr = (n) => rule(':root[data-theme="dark"] ', n);

const names = new Set([...CATEGORY_ICON_CHOICES, ...DEFAULT_CATEGORIES.map((c) => c.icon)]);

const rgb = (s) => {
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return { c: [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16)), a: 1 };
  m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(s);
  assert.ok(m, `unparseable colour ${s}`);
  return { c: [+m[1], +m[2], +m[3]], a: +m[4] };
};
const over = (top, under) => top.c.map((v, i) => v * top.a + under[i] * (1 - top.a));
const lum = (c) => {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('every selectable and default icon has a light and dark colour rule', () => {
  assert.equal(names.size >= 18, true);
  for (const n of names) {
    assert.ok(lightRuleFor(n), `light ${n}`);
    assert.ok(darkMedia(n), `dark media ${n}`);
    assert.ok(darkAttr(n), `dark attr ${n}`);
  }
});

test('both dark blocks carry identical values', () => {
  for (const n of names) assert.deepEqual(darkMedia(n), darkAttr(n), n);
});

test('foreground reaches 3:1 against its circle in light and dark', () => {
  for (const n of names) {
    const l = lightRuleFor(n);
    assert.ok(contrast(rgb(l.fg).c, rgb(l.bg).c) >= 3, `light ${n}`);
    const d = darkAttr(n);
    const bg = over(rgb(d.bg), [0x1a, 0x1d, 0x23]); // 叠在深色抽屉 #1A1D23 上
    assert.ok(contrast(rgb(d.fg).c, bg) >= 3, `dark ${n}`);
  }
});

test('icon containers are wired to data-icon', () => {
  assert.match(css, /\.home-row-icon\[data-icon\]\s*\{[^}]*var\(--cat-bg,/);
  assert.match(css, /\.cat-tile\[data-icon\] \.cat-tile-icon\s*\{[^}]*var\(--cat-bg,/);
});

test('there is a dark @media block with the icon rules, and the attr rules sit outside any @media', () => {
  assert.equal(mediaWithIcons.length, 1);
  const attrIdxs = [];
  for (let at = css.indexOf(':root[data-theme="dark"] [data-icon='); at >= 0;
    at = css.indexOf(':root[data-theme="dark"] [data-icon=', at + 1)) attrIdxs.push(at);
  assert.ok(attrIdxs.length >= 18);
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const start = m.index + m[0].length - 1;
    let depth = 0, k = start;
    for (; k < css.length; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}' && --depth === 0) break;
    }
    for (const attrIdx of attrIdxs) assert.ok(!(attrIdx > start && attrIdx < k), 'attr dark rules must not be inside @media');
  }
});

test('colour use sites carry a grey fallback', () => {
  assert.doesNotMatch(css, /var\(--cat-(bg|fg)\)/);
});

// v2.4 统计页百分比胶囊：字压在 --cat-bg 上。浅色用加深的 --cat-ink；深色用通用规则 --cat-ink = --cat-fg
const inkOf = (n) => {
  const m = new RegExp(`(?:^|\\n)\\[data-icon="${n}"\\]\\s*\\{([^}]*)\\}`).exec(css);
  const v = m && /--cat-ink:\s*([^;]+);/.exec(m[1]);
  return v ? v[1].trim() : null;
};
test('stats pill: light --cat-ink on --cat-bg >= 4.5 for every icon', () => {
  for (const n of names) {
    const ink = inkOf(n);
    assert.ok(ink, `light --cat-ink ${n}`);
    const l = lightRuleFor(n);
    assert.ok(contrast(rgb(ink).c, rgb(l.bg).c) >= 4.5, `light pill ${n}`);
  }
});
test('stats pill: dark --cat-fg on drawer + --cat-bg >= 4.5, and dark blocks reset --cat-ink to --cat-fg', () => {
  const drawer = [0x1A, 0x1D, 0x23];
  for (const n of names) {
    const d = darkAttr(n);
    assert.ok(contrast(rgb(d.fg).c, over(rgb(d.bg), drawer)) >= 4.5, `dark pill ${n}`);
  }
  assert.match(css, /\n\s*:root:not\(\[data-theme="light"\]\) \[data-icon\] \{ --cat-ink: var\(--cat-fg, var\(--secondary-label\)\); \}/);
  assert.match(css, /\n:root\[data-theme="dark"\] \[data-icon\] \{ --cat-ink: var\(--cat-fg, var\(--secondary-label\)\); \}/);
});
