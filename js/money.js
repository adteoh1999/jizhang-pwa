// RM 金额：一律以整数「仙」(minor) 存取；解析用纯字串处理，不用 parseFloat。
export const MAX_MINOR = 9999999999;

const INT_OK = /^(\d+|\d{1,3}(,\d{3})+)$/;

export function parseAmount(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '') return null;
  const parts = s.split('.');
  if (parts.length > 2) return null;
  const intRaw = parts[0];
  const frac = parts.length === 2 ? parts[1] : '';
  if (intRaw === '' && parts.length === 1) return null;
  if (intRaw !== '' && !INT_OK.test(intRaw)) return null;
  if (!/^\d{0,2}$/.test(frac)) return null;
  if (intRaw === '' && frac === '') return null;
  const intDigits = intRaw.replace(/,/g, '') || '0';
  if (intDigits.length > 10) return null;
  const minor = Number(intDigits) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_MINOR) return null;
  return minor;
}

export function minorToDecimalString(minor) {
  const abs = Math.abs(Math.trunc(minor));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatRM(minor, opts = {}) {
  const sign = opts.sign || 'negative';
  const abs = Math.abs(Math.trunc(minor));
  const [i, f] = minorToDecimalString(abs).split('.');
  const body = `RM ${group(i)}.${f}`;
  if (sign === 'none') return body;
  if (minor < 0) return '−' + body;
  if (sign === 'always' && minor > 0) return '+' + body;
  return body;
}
