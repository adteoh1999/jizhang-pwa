// 当地日期工具：一律用当地 getFullYear/getMonth/getDate，绝不用 toISOString。
const pad = (n, w = 2) => String(n).padStart(w, '0');
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toLocalDateString(d) {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayLocal(now = new Date()) {
  return toLocalDateString(now);
}

export function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}`;
}

export function formatMonthTitle(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y} 年 ${m} 月`;
}

export function isValidDateString(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// 与时区无关：用 UTC 纯算术得到天数序号与星期
function dayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function formatDayHeader(dateStr, today) {
  const diff = dayNumber(today) - dayNumber(dateStr);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const sameYear = y === Number(today.slice(0, 4));
  return `${sameYear ? '' : y + '年'}${m}月${d}日 ${wd}`;
}
