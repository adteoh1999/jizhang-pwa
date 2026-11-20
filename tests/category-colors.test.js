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
// 必须出现在最后一个 prefers-color-scheme: dark 区块之内（区块从其 @media 起、到下一个顶层规则前）
const darkMedia = (n) => {
  const i = css.lastIndexOf('@media (prefers-color-scheme: dark)');
  const end = css.indexOf('\n}\n', i);
  const body = css.slice(i, end);
  return body.includes(`:root:not([data-theme="light"]) [data-icon="${n}"]`)
    ? rule(':root:not([data-theme="light"]) ', n) : null;
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
  assert.match(css, /\.home-row-icon\[data-icon\]\s*\{[^}]*var\(--cat-bg\)/);
  assert.match(css, /\.cat-tile\[data-icon\] \.cat-tile-icon\s*\{[^}]*var\(--cat-bg\)/);
});
