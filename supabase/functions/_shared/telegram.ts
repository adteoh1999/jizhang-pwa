// Telegram 身份资料（Mini App initData）验证（3a-1），只用 Web Crypto
// 算法：https://core.telegram.org/bots/webapps 「Validating data received via the Mini App」
//   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash 要等于 hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
//   data_check_string：除了 hash 以外的「全部」栏位（含 signature），按 key 排序、key=value（解码后）、以 \n 连接
// 打包规则：这个档不能 import 别档；顶层名字一律 tg 开头（不分大小写），免得和其他 _shared 档撞名。
// 任何不合格都不 throw；不记任何日志（呼叫端只记失败原因种类）。

export type TgUser = { telegramId: string; label: string };

const TG_MAX_INIT_DATA = 4096;      // 真机若因长度失败，先量实际长度再调
const TG_MAX_AGE_LIMIT_SEC = 86400; // maxAgeSec 最多 24 小时
const TG_FUTURE_SKEW_SEC = 60;      // auth_date 最多可以比服务器时间快 60 秒
const TG_LABEL_MAX = 64;            // 码点

// bot token 长这样：数字:30 个以上英数字或 _-（去头尾空白后判断）
export function tgBotTokenOk(token: string | undefined): token is string {
  return typeof token === 'string' && /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

// 显示名：有 username 用 @username，否则「名 姓」；去掉控制字元与格式字元（零宽、方向字元），
// 空白并成一个，按码点截 64（不切开代理对），前后去空白
export function tgLabel(user: unknown): string {
  const u = (user && typeof user === 'object') ? user as Record<string, unknown> : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const raw = str(u.username) ? '@' + str(u.username) : `${str(u.first_name)} ${str(u.last_name)}`;
  // Cc 控制字元（换行、Tab 直接删掉，不变空格）、Cf 格式字元（零宽、方向字元；也会拆开 U+200D 组合表情，只是显示名，可接受）、
  // Cs 孤立的代理字元（半个表情符号，送进 Postgres 的 JSON 会被拒）
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '').replace(/\s+/gu, ' ').trim();
  return [...clean].slice(0, TG_LABEL_MAX).join('').trimEnd();
}

function tgHexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function tgHmacKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export type TgVerifyFail = 'token' | 'format' | 'length' | 'dup' | 'hash' | 'expired' | 'future' | 'user';

// 注意：maxAgeSec 内同一份 initData 可以重放（这里不管）；呼叫端各自取短（3b：tg-login 300 秒、bind 600 秒）
// 失败原因种类只给服务器日志用，不回前端：
//   token 设定的 bot token 不合格｜format 参数或 auth_date 格式不对｜length 不是字串、空的或太长｜dup 同一栏位出现两次
//   hash 缺 hash 或签名不符｜expired 太旧｜future 比服务器时间快 60 秒以上｜user user 栏位缺少或不合格（含 bot）
export async function tgVerifyInitDataWhy(
  initData: string, botToken: string | undefined, nowSec: number, maxAgeSec: number,
): Promise<{ user: TgUser } | { fail: TgVerifyFail }> {
  const no = (fail: TgVerifyFail) => ({ fail });
  try {
    if (typeof nowSec !== 'number' || !Number.isFinite(nowSec) || nowSec <= 0) return no('format');
    if (typeof maxAgeSec !== 'number' || !Number.isFinite(maxAgeSec) || maxAgeSec <= 0 || maxAgeSec > TG_MAX_AGE_LIMIT_SEC) return no('format');
    if (!tgBotTokenOk(botToken)) return no('token');
    const token = botToken.trim();
    if (typeof initData !== 'string' || initData === '' || initData.length > TG_MAX_INIT_DATA) return no('length');

    const params = new URLSearchParams(initData);
    const fields = new Map<string, string>();
    for (const [k, v] of params) {
      if (fields.has(k)) return no('dup'); // 同一个 key 出现两次（含 hash）
      fields.set(k, v);
    }
    const hash = fields.get('hash');
    if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return no('hash');

    const dcs = [...fields.keys()].filter((k) => k !== 'hash').sort()
      .map((k) => `${k}=${fields.get(k)}`).join('\n');
    const enc = new TextEncoder();
    const secretKey = await tgHmacKey(enc.encode('WebAppData'), 'sign');
    const secret = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, enc.encode(token)));
    const checkKey = await tgHmacKey(secret, 'verify');
    if (!(await crypto.subtle.verify('HMAC', checkKey, tgHexBytes(hash), enc.encode(dcs)))) return no('hash');

    const authDate = fields.get('auth_date');
    if (!authDate || !/^\d{1,12}$/.test(authDate)) return no('format');
    const t = Number(authDate);
    if (t < nowSec - maxAgeSec) return no('expired');
    if (t > nowSec + TG_FUTURE_SKEW_SEC) return no('future');

    const userJson = fields.get('user');
    if (!userJson) return no('user');
    let user: unknown;
    try { user = JSON.parse(userJson); } catch { return no('user'); }
    if (!user || typeof user !== 'object' || Array.isArray(user)) return no('user');
    const u = user as Record<string, unknown>;
    if (typeof u.id !== 'number' || !Number.isSafeInteger(u.id) || u.id <= 0) return no('user');
    if (u.is_bot === true) return no('user');

    return { user: { telegramId: String(u.id), label: tgLabel(u) } };
  } catch {
    return no('format');
  }
}

// 任何不合格一律回 null（行为与 3a-1 相同）
export async function tgVerifyInitData(initData: string, botToken: string | undefined, nowSec: number, maxAgeSec: number): Promise<TgUser | null> {
  const r = await tgVerifyInitDataWhy(initData, botToken, nowSec, maxAgeSec);
  return 'user' in r ? r.user : null;
}

// 叫 Telegram Bot API（https://core.telegram.org/bots/api#making-requests：POST JSON，回 {ok, result}）。
// 不 throw、不记日志、不回原始回应；网址含 token，所以连线错误的讯息也一律丢掉。
export async function tgBotCall(
  fetchFn: typeof fetch, token: string | undefined, method: string, payload: unknown, timeoutMs = 5000,
): Promise<{ ok: true } | { ok: false; status: number }> {
  if (!tgBotTokenOk(token) || typeof method !== 'string' || !/^[A-Za-z]{1,64}$/.test(method)) return { ok: false, status: 0 };
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token.trim()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok && data && data.ok === true) return { ok: true };
    return { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
