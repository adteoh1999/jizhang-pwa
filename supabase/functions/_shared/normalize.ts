// 邮箱、邀请码的正规化（前后端规则要一致）

const INVITE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

// 去前后空白、转小写；不像邮箱就回 ''
export function normalizeEmail(s: unknown): string {
  if (typeof s !== 'string') return '';
  const e = s.trim().toLowerCase();
  if (e.length > 254 || /\s/.test(e)) return '';
  const at = e.indexOf('@');
  if (at < 1 || at !== e.lastIndexOf('@') || at === e.length - 1) return '';
  return e;
}

// 去空白和连字号、转大写；不是 8 个字母表内的字就回 ''
export function normalizeInviteCode(s: unknown): string {
  if (typeof s !== 'string') return '';
  const c = s.replace(/[\s-]/g, '').toUpperCase();
  return INVITE_RE.test(c) ? c : '';
}

export function formatInviteCode(code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4);
}
