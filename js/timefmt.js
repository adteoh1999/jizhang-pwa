// 服务器时间戳正规化与 uuid 检查（纯函数，给同步用）。
// 不把原字串直接丢给 Date.parse：iOS Safari 对微秒、'+00'、空格分隔等非标准格式不可靠。

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// '2026-11-24T05:02:09.123456+00:00' → '2026-11-24T05:02:09.123Z'；看不懂回 null。
export function normalizeTs(s) {
  if (typeof s !== 'string') return null;
  const m = TS_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac = '', tz] = m;
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +se;
  // Y < 1000：Date.UTC 会把 0–99 年当成 19xx；这么早的时间不会是真资料，当成看不懂
  if (Y < 1000 || M < 1 || M > 12 || D < 1 || H > 23 || MI > 59 || S > 59) return null;
  if (D > new Date(Date.UTC(Y, M, 0)).getUTCDate()) return null; // 该月天数
  const ms = +(frac + '000').slice(0, 3); // 截到毫秒，不进位
  let offsetMin = 0;
  if (tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2) : 0;
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const t = Date.UTC(Y, M - 1, D, H, MI, S, ms) - offsetMin * 60_000;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}
