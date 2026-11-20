// 图示：24x24 viewBox、2px 线条、圆角端点、currentColor。全部为自绘路径。
// 数据与 DOM 分离：ICON_DATA 可在 Node 中直接导入，只有 icon() 在调用时才用 document。
const SVG_NS = 'http://www.w3.org/2000/svg';

// 圆：cx cy r -> 路径
const dot = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

export const ICON_DATA = {
  // 分类（默认）
  food: ['M7 3v7', 'M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3', 'M7 10v11', 'M17 21V3c-2.2 1.5-3 4-3 7v3h3'],
  transport: ['M5 16V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v8Z', 'M5 11h14', 'M7 16v3', 'M17 16v3', dot(8.5, 13.5, 0.5), dot(15.5, 13.5, 0.5)],
  shopping: ['M5 8h14l-1 12H6Z', 'M9 8V7a3 3 0 0 1 6 0v1'],
  bills: ['M6 3h12v18l-3-2-3 2-3-2-3 2Z', 'M9 8h6', 'M9 12h6'],
  fun: ['M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z', 'M14 7v2', 'M14 11v2', 'M14 15v2'],
  other: [dot(6, 12, 1), dot(12, 12, 1), dot(18, 12, 1)],
  // 分类（收入）
  salary: ['M3 7h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M3 12h18', 'M11 12h2v2h-2Z'],
  bonus: ['M4 10h16v10H4Z', 'M3 7h18v3H3Z', 'M12 7v13', 'M12 7c-1-3-5-4-5-1.5C7 7 9 7 12 7c3 0 5 0 5-1.5C17 3 13 4 12 7Z'],
  side: ['M12 4v3', 'M9 7h6', 'M8 7l-3 7a5 5 0 0 0 4.7 6h4.6a5 5 0 0 0 4.7-6l-3-7', 'M9.5 14h5'],
  other_income: ['M12 20V6', 'M6 12l6-6 6 6', 'M5 20h14'],
  // 分类（自建可选）
  pet: [dot(6.5, 10, 1.5), dot(10, 6, 1.5), dot(14, 6, 1.5), dot(17.5, 10, 1.5), 'M8 17c0-3 2-5 4-5s4 2 4 5c0 2-2 2-4 1.5C10 19 8 19 8 17Z'],
  health: ['M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20Z', 'M12 10v5', 'M9.5 12.5h5'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10', 'M10 20v-5h4v5'],
  gift: ['M4 11h16v9H4Z', 'M3 8h18v3H3Z', 'M12 8v12', 'M12 8c-1-3-4.5-3.5-4.5-1.5S10 8 12 8Z', 'M12 8c1-3 4.5-3.5 4.5-1.5S14 8 12 8Z'],
  travel: ['M2.5 14l8-1.5L7 4.5h2.5l6 7 4-.8a1.7 1.7 0 0 1 .5 3.3l-4 .8-3.5 6.2H10l1.5-6.3L5 15.5 3.5 17Z'],
  education: ['M2 9l10-5 10 5-10 5Z', 'M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5', 'M22 9v6'],
  coffee: ['M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z', 'M16 10h1.5a2.5 2.5 0 0 1 0 5H16', 'M8 3v3', 'M12 3v3'],
  phone: ['M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'M10.5 18h3'],
  // 介面
  house: ['M4 11l8-7 8 7', 'M6 10v10h12V10'],
  chart: ['M4 20h16', 'M7 20v-7', 'M12 20V5', 'M17 20v-10'],
  gear: [dot(12, 12, 3), 'M12 3v2.5', 'M12 18.5V21', 'M3 12h2.5', 'M18.5 12H21', 'M5.6 5.6l1.8 1.8', 'M16.6 16.6l1.8 1.8', 'M18.4 5.6l-1.8 1.8', 'M7.4 16.6l-1.8 1.8'],
  plus: ['M12 5v14', 'M5 12h14'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-right': ['M9 5l7 7-7 7'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  share: ['M12 15V3', 'M8 7l4-4 4 4', 'M6 11H5v10h14V11h-1'],
  'square-arrow-up': ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M12 17V8', 'M8.5 11.5L12 8l3.5 3.5'],
};

export const ICON_NAMES = Object.keys(ICON_DATA);

export const CATEGORY_ICON_CHOICES = [
  'food', 'transport', 'shopping', 'bills', 'fun', 'other',
  'salary', 'bonus', 'side', 'other_income',
  'pet', 'health', 'home', 'gift', 'travel', 'education', 'coffee', 'phone',
];

/** 返回 SVGElement；未知名称退回 'other'，不会抛错。 */
export function icon(name, size = 24) {
  const paths = Object.hasOwn(ICON_DATA, name) ? ICON_DATA[name] : ICON_DATA.other;
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
