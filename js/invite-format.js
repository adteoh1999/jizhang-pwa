// 邀请码显示用的纯函数（2f Task 8）。日期一律用马来西亚时间（UTC+8，没有夏令时间），跟设备时区无关。
import { normalizeTs } from './timefmt.js';

export const USES_MIN = 1;
export const USES_MAX = 20;
export const NOTE_MAX = 40;
export const DEFAULT_DAYS = 7;
export const VALIDITY_OPTIONS = Object.freeze([
  { label: '1 天', days: 1 }, { label: '7 天', days: 7 }, { label: '30 天', days: 30 }, { label: '永不过期', days: null },
]);
const APP_URL = 'https://jizhang.adteoh.com';
const MY_OFFSET_MS = 8 * 60 * 60 * 1000;
const STATUS = { active: '有效', disabled: '已停用', expired: '已过期', used_up: '已用完' };

/** 'K7MPQ4XZ' → 'K7MP-Q4XZ'（不是 8 码原样）。 */
export function formatCode(code) {
  const s = typeof code === 'string' ? code : '';
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/** 读屏用：逐字分开、两组之间停顿（'K 7 M P，Q 4 X Z'）。 */
export function spokenCode(code) {
  const s = typeof code === 'string' ? code : '';
  const spaced = (x) => [...x].join(' ');
  return s.length === 8 ? `${spaced(s.slice(0, 4))}，${spaced(s.slice(4))}` : spaced(s);
}

export const statusLabel = (status) => STATUS[status] || '';
export const usesLabel = (used, max) => `已用 ${used}/${max}`;

/** 服务器时间 → 马来西亚的「M月D日」；看不懂回 ''。 */
export function dateLabelMY(ts) {
  const iso = normalizeTs(ts);
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + MY_OFFSET_MS);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function expiryLabel(expiresAt) {
  if (expiresAt === null || expiresAt === undefined) return '永不过期';
  const d = dateLabelMY(expiresAt);
  return d ? `${d}到期` : '';
}

/** 列表第二行：「有效 · 已用 0/1 · 12月2日到期」（看不懂的段落略过）。 */
export function inviteMeta(inv) {
  return [statusLabel(inv.status), usesLabel(inv.used_count, inv.max_uses), expiryLabel(inv.expires_at)]
    .filter(Boolean).join(' · ');
}

export const shareText = (code) => `用邀请码 ${formatCode(code)} 注册：${APP_URL}`;

/** 次数夹到 1–20 的整数（不是数字 → 1）。 */
export function clampUses(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return USES_MIN;
  return Math.min(USES_MAX, Math.max(USES_MIN, v));
}
