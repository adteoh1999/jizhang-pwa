import test from 'node:test';
import assert from 'node:assert/strict';
import { ICON_NAMES, ICON_DATA, CATEGORY_ICON_CHOICES, ICON_LABELS, iconKey } from '../js/ui/icons.js';

const REQUIRED = [
  'food', 'transport', 'shopping', 'bills', 'fun', 'other',
  'salary', 'bonus', 'side', 'other_income',
  'pet', 'health', 'home', 'gift', 'travel', 'education', 'coffee', 'phone',
  'house', 'chart', 'gear', 'plus', 'chevron-left', 'chevron-right', 'trash', 'share', 'square-arrow-up',
];

test('all required icon names exist', () => {
  for (const n of REQUIRED) assert.ok(ICON_NAMES.includes(n), `missing ${n}`);
});

test('CATEGORY_ICON_CHOICES has 18 entries, all defined, in order', () => {
  assert.equal(CATEGORY_ICON_CHOICES.length, 18);
  assert.deepEqual(CATEGORY_ICON_CHOICES, REQUIRED.slice(0, 18));
  for (const n of CATEGORY_ICON_CHOICES) assert.ok(ICON_NAMES.includes(n));
});

test('ICON_LABELS：每个 CATEGORY_ICON_CHOICES 都有中文名称，且没有多余项目', () => {
  for (const n of CATEGORY_ICON_CHOICES) {
    assert.equal(typeof ICON_LABELS[n], 'string', `missing label ${n}`);
    assert.match(ICON_LABELS[n], /^[\u4e00-\u9fff]+$/, n);
  }
  assert.deepEqual(Object.keys(ICON_LABELS).sort(), [...CATEGORY_ICON_CHOICES].sort());
  assert.ok(Object.isFrozen(ICON_LABELS));
});

test('every path string is non-empty and only has path commands and numbers', () => {
  for (const name of ICON_NAMES) {
    const paths = ICON_DATA[name];
    assert.ok(Array.isArray(paths) && paths.length > 0, name);
    for (const d of paths) {
      assert.equal(typeof d, 'string');
      assert.ok(d.trim().length > 0, name);
      assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9\s.,-]+$/, name);
      assert.match(d.trim(), /^[Mm]/, name);
    }
  }
});

// ---- icon()：用手写的假 document，不依赖 DOM ----
function fakeDocument() {
  const mk = (tag) => ({
    tag, attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
  });
  return { createElementNS: (ns, tag) => Object.assign(mk(tag), { ns }) };
}

async function withFakeDoc(fn) {
  const { icon } = await import('../js/ui/icons.js');
  const saved = globalThis.document;
  globalThis.document = fakeDocument();
  try { fn(icon); } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
}

test('icon() 生成正确属性与路径数量', async () => {
  await withFakeDoc((icon) => {
    const svg = icon('trash', 20);
    assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
    assert.equal(svg.attrs.viewBox, '0 0 24 24');
    assert.equal(svg.attrs.width, '20');
    assert.equal(svg.attrs.height, '20');
    assert.equal(svg.attrs.fill, 'none');
    assert.equal(svg.attrs.stroke, 'currentColor');
    assert.equal(svg.attrs['stroke-width'], '2');
    assert.equal(svg.attrs['stroke-linecap'], 'round');
    assert.equal(svg.attrs['stroke-linejoin'], 'round');
    assert.equal(svg.attrs['aria-hidden'], 'true');
    assert.equal(svg.children.length, ICON_DATA.trash.length);
    for (const c of svg.children) {
      assert.equal(c.tag, 'path');
      assert.equal(c.ns, 'http://www.w3.org/2000/svg');
    }
    assert.equal(icon('plus').attrs.width, '24');
  });
});

test('icon() 未知名称与 toString 退回 other', async () => {
  await withFakeDoc((icon) => {
    for (const n of ['nope', 'toString', '__proto__', undefined]) {
      const svg = icon(n);
      assert.equal(svg.children.length, ICON_DATA.other.length);
      assert.equal(svg.children[0].attrs.d, ICON_DATA.other[0]);
    }
  });
});

test('图示数据被冻结', () => {
  assert.ok(Object.isFrozen(ICON_DATA));
  for (const n of ICON_NAMES) assert.ok(Object.isFrozen(ICON_DATA[n]), n);
  assert.ok(Object.isFrozen(ICON_NAMES));
  assert.ok(Object.isFrozen(CATEGORY_ICON_CHOICES));
});

test('iconKey keeps coloured names and resolves unknown names to other', () => {
  for (const n of CATEGORY_ICON_CHOICES) assert.equal(iconKey(n), n);
  for (const n of ['unknown', 'house', '', undefined, null, 'constructor']) assert.equal(iconKey(n), 'other');
});
