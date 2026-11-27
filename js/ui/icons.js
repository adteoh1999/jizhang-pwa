// 图示：24x24 viewBox、2px 线条、圆角端点、currentColor。全部为自绘路径。
// 数据与 DOM 分离：ICON_DATA 可在 Node 中直接导入，只有 icon() 在调用时才用 document。
const SVG_NS = 'http://www.w3.org/2000/svg';

// 圆：cx cy r -> 路径
const dot = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

const RAW = {
  // 分类（默认）
  food: ['M7 3v7', 'M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3', 'M7 10v11', 'M17 21V3c-2.2 1.5-3 4-3 7v3h3'],
  transport: ['M5 16V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8Z', 'M5 10h14', 'M7 16v3', 'M17 16v3', dot(8.5, 12.9, 0.5), dot(15.5, 12.9, 0.5)],
  shopping: ['M5 8h14l-1 12H6Z', 'M9 8V7a3 3 0 0 1 6 0v1'],
  bills: ['M6 3h12v18l-3-2-3 2-3-2-3 2Z', 'M9 8h6', 'M9 12h6'],
  fun: ['M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z', 'M14 7v2', 'M14 11v2', 'M14 15v2'],
  other: [dot(6, 12, 1), dot(12, 12, 1), dot(18, 12, 1)],
  // 分类（收入）
  salary: ['M3 7h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M3 12h18', 'M11 12h2v2h-2Z'],
  bonus: [dot(12, 9, 5), 'M8.5 13l-2 8 5.5-3 5.5 3-2-8'],
  side: ['M6 5h12a1 1 0 0 1 1 1v9H5V6a1 1 0 0 1 1-1Z', 'M3 19h18'],
  other_income: ['M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z', dot(12, 12, 2.5)],
  // 分类（自建可选）
  pet: [dot(5.5, 11, 1), dot(9, 6.5, 1), dot(15, 6.5, 1), dot(18.5, 11, 1), 'M8 18c0-3 2-5 4-5s4 2 4 5c0 1.5-2 1.5-4 1.2-2 .3-4 .3-4-1.2Z'],
  health: ['M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20Z', 'M12 10v5', 'M9.5 12.5h5'],
  home: ['M7 10V8a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2', 'M5 10a2 2 0 0 0-2 2v5h18v-5a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2H7v-2a2 2 0 0 0-2-2Z', 'M6 17v2', 'M18 17v2'],
  gift: ['M4 11h16v9H4Z', 'M3 8h18v3H3Z', 'M12 8v12', 'M12 8c-1-3-4.5-3.5-4.5-1.5S10 8 12 8Z', 'M12 8c1-3 4.5-3.5 4.5-1.5S14 8 12 8Z'],
  travel: ['M2.5 14l8-1.5L7 4.5h2.5l6 7 4-.8a1.7 1.7 0 0 1 .5 3.3l-4 .8-3.5 6.2H10l1.5-6.3L5 15.5 3.5 17Z'],
  education: ['M3 9l9-4.5L21 9l-9 4.5Z', 'M6.5 11.5V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.5', 'M21 9v5'],
  coffee: ['M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z', 'M16 10h1.5a2.5 2.5 0 0 1 0 5H16', 'M8 3v3', 'M12 3v3'],
  phone: ['M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M10.5 18h3'],
  // 介面
  house: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
  chart: ['M4 20h16', 'M7 20v-7', 'M12 20V5', 'M17 20v-10'],
  gear: ['M10.0 5.7L10.3 3.2L13.7 3.2L14.0 5.7L15.1 6.2L17.0 4.5L19.5 7.0L17.8 8.9L18.3 10.0L20.8 10.3L20.8 13.7L18.3 14.0L17.8 15.1L19.5 17.0L17.0 19.5L15.1 17.8L14.0 18.3L13.7 20.8L10.3 20.8L10.0 18.3L8.9 17.8L7.0 19.5L4.5 17.0L6.2 15.1L5.7 14.0L3.2 13.7L3.2 10.3L5.7 10.0L6.2 8.9L4.5 7.0L7.0 4.5L8.9 6.2Z', dot(12, 12, 2.5)],
  plus: ['M12 5v14', 'M5 12h14'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  share: ['M12 15V3', 'M8 7l4-4 4 4', 'M6 11H5v10h14V11h-1'],
  // 结余卡「隐藏金额」：睁眼＝金额显示中（点了会隐藏），闭眼（加斜线）＝已隐藏
  eye: ['M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z', dot(12, 12, 3)],
  'eye-off': ['M3 3l18 18', 'M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8', 'M6.3 7.2A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.3 9.3 0 0 0 4.4-1.1', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],   // v2.3.1 起没人用（原本是储存成功的 ✓）；要不要删待用户决定
  'square-arrow-up': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M12 17V8', 'M8.5 11.5L12 8l3.5 3.5'],
};

// 深冻结：数据不可被外部改动
export const ICON_DATA = Object.freeze(Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, Object.freeze(v)])));

export const ICON_NAMES = Object.freeze(Object.keys(ICON_DATA));

export const CATEGORY_ICON_CHOICES = Object.freeze([
  'food', 'transport', 'shopping', 'bills', 'fun', 'other',
  'salary', 'bonus', 'side', 'other_income',
  'pet', 'health', 'home', 'gift', 'travel', 'education', 'coffee', 'phone',
]);

// 分类图示的中文名称（图示选择器的 aria-label）；与 CATEGORY_ICON_CHOICES 一一对应（测试会检查）
export const ICON_LABELS = Object.freeze({
  food: '餐饮', transport: '交通', shopping: '购物', bills: '账单', fun: '娱乐', other: '其他',
  salary: '工资', bonus: '奖金', side: '副业', other_income: '其他收入',
  pet: '宠物', health: '医疗', home: '居家', gift: '礼物', travel: '旅行', education: '教育',
  coffee: '咖啡', phone: '手机',
});

/** 分类圆标颜色的键：只有 CATEGORY_ICON_CHOICES 内的名称有配色，其余（未知名称）一律退回 'other'。 */
// 注意：非分类用的字形名称（如 'house'）刻意映射到 'other' 的配色，与 icon() 的字形解析不同。
export function iconKey(name) {
  return CATEGORY_ICON_CHOICES.includes(name) ? name : 'other';
}

/** 列图示的 data-icon：有效分类 → iconKey；已删除 / 未分类 → null（维持灰色）。 */
export function rowIconAttr(cat) {
  return cat && !cat.deleted ? iconKey(cat.icon) : null;
}

// 导航栏图示（B 改版 2026-11-27，用户选定：房子、圆饼一块分开、齿轮）：线宽 1.8、圆端点圆转角（像 SF Symbols）。
// line＝线条版（没选中）；solid＝描边＋填色 evenodd（转角跟线条版一样圆）；solidFlat＝只填色不描边（外缘已算好，留出缝）。
// 齿轮：8 齿、外 9.0／内 6.9、齿顶半角 9°、齿根半角 15°，第一齿朝上（产生器 scratchpad tp_gen_icons.py 的 gear()）。
const GEAR = 'M10.21 5.34 L10.59 3.11 L13.41 3.11 L13.79 5.34 L15.45 6.02 L17.29 4.72 L19.28 6.71 L17.98 8.55 L18.66 10.21 L20.89 10.59 L20.89 13.41 L18.66 13.79 L17.98 15.45 L19.28 17.29 L17.29 19.28 L15.45 17.98 L13.79 18.66 L13.41 20.89 L10.59 20.89 L10.21 18.66 L8.55 17.98 L6.71 19.28 L4.72 17.29 L6.02 15.45 L5.34 13.79 L3.11 13.41 L3.11 10.59 L5.34 10.21 L6.02 8.55 L4.72 6.71 L6.71 4.72 L8.55 6.02 Z';
const HOUSE = 'M4 10.4L12 4l8 6.4v8.2a1.9 1.9 0 0 1-1.9 1.9H5.9A1.9 1.9 0 0 1 4 18.6Z';
export const TAB_ICON_DATA = Object.freeze({
  'tab-home': Object.freeze({
    line: Object.freeze([HOUSE, 'M9.8 20.5v-4.6a2.2 2.2 0 0 1 4.4 0v4.6']),
    solid: Object.freeze([`${HOUSE} M9.3 20.5v-4.6a2.7 2.7 0 0 1 5.4 0v4.6Z`]),
    solidFlat: Object.freeze([]),
  }),
  'tab-stats': Object.freeze({
    line: Object.freeze(['M11.2 12.8H19.2A8 8 0 1 1 11.2 4.8Z', 'M12.9 11.1V3.7A7.4 7.4 0 0 1 20.3 11.1Z']),
    solid: Object.freeze([]),
    solidFlat: Object.freeze(['M11.2 12.8H20.1A8.9 8.9 0 1 1 11.2 3.9Z', 'M12.9 11.1V2.8A8.3 8.3 0 0 1 21.2 11.1Z']),
  }),
  'tab-settings': Object.freeze({
    line: Object.freeze([GEAR, 'M9.1 12a2.9 2.9 0 1 0 5.8 0a2.9 2.9 0 1 0 -5.8 0Z']),
    solid: Object.freeze([`${GEAR} M8.4 12a3.6 3.6 0 1 0 7.2 0a3.6 3.6 0 1 0 -7.2 0Z`]),
    solidFlat: Object.freeze([]),
  }),
});

/** 导航栏图示：两组 <g>（.tab-ic-line／.tab-ic-solid），CSS 依选中状态切 opacity。未知名称退回首页图示。 */
export function tabIcon(name, size = 24) {
  const d = Object.prototype.hasOwnProperty.call(TAB_ICON_DATA, name) ? TAB_ICON_DATA[name] : TAB_ICON_DATA['tab-home'];
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', String(size)], ['height', String(size)], ['fill', 'none'],
    ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) {
    svg.setAttribute(k, v);
  }
  const group = (cls, items) => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', cls);
    for (const [path, attrs] of items) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', path);
      for (const [k, v] of attrs) p.setAttribute(k, v);
      g.appendChild(p);
    }
    return g;
  };
  const fill = [['fill', 'currentColor'], ['fill-rule', 'evenodd']];
  svg.appendChild(group('tab-ic-line', d.line.map((p) => [p, []])));
  svg.appendChild(group('tab-ic-solid', [...d.solid.map((p) => [p, fill]), ...d.solidFlat.map((p) => [p, [...fill, ['stroke', 'none']]])]));
  return svg;
}

/** 返回 SVGElement；未知名称退回 'other'，不会抛错。 */
export function icon(name, size = 24) {
  const paths = Object.prototype.hasOwnProperty.call(ICON_DATA, name) ? ICON_DATA[name] : ICON_DATA.other;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
