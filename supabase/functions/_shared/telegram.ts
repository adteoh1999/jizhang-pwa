// Telegram 身份资料（Mini App initData）验证（3a-1），只用 Web Crypto
// 算法：https://core.telegram.org/bots/webapps 「Validating data received via the Mini App」
//   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash 要等于 hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
//   data_check_string：除了 hash 以外的「全部」栏位（含 signature），按 key 排序、key=value（解码后）、以 \n 连接
// 打包规则：这个档不能 import 别档；顶层名字一律 tg 开头（不分大小写），免得和其他 _shared 档撞名。
// 任何不合格一律回 null、不 throw；不记任何日志（呼叫端只记「验证失败」）。

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

// 注意：maxAgeSec 内同一份 initData 可以重放（这里不管）；tg-login 的时效要取短（3b 定）
export async function tgVerifyInitData(initData: string, botToken: string | undefined, nowSec: number, maxAgeSec: number): Promise<TgUser | null> {
  try {
    if (typeof nowSec !== 'number' || !Number.isFinite(nowSec) || nowSec <= 0) return null;
    if (typeof maxAgeSec !== 'number' || !Number.isFinite(maxAgeSec) || maxAgeSec <= 0 || maxAgeSec > TG_MAX_AGE_LIMIT_SEC) return null;
    if (!tgBotTokenOk(botToken)) return null;
    const token = botToken.trim();
    if (typeof initData !== 'string' || initData === '' || initData.length > TG_MAX_INIT_DATA) return null;

    const params = new URLSearchParams(initData);
    const fields = new Map<string, string>();
    for (const [k, v] of params) {
      if (fields.has(k)) return null; // 同一个 key 出现两次（含 hash）
      fields.set(k, v);
    }
    const hash = fields.get('hash');
    if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;

    const dcs = [...fields.keys()].filter((k) => k !== 'hash').sort()
      .map((k) => `${k}=${fields.get(k)}`).join('\n');
    const enc = new TextEncoder();
    const secretKey = await tgHmacKey(enc.encode('WebAppData'), 'sign');
    const secret = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, enc.encode(token)));
    const checkKey = await tgHmacKey(secret, 'verify');
    if (!(await crypto.subtle.verify('HMAC', checkKey, tgHexBytes(hash), enc.encode(dcs)))) return null;

    const authDate = fields.get('auth_date');
    if (!authDate || !/^\d{1,12}$/.test(authDate)) return null;
    const t = Number(authDate);
    if (!(t >= nowSec - maxAgeSec && t <= nowSec + TG_FUTURE_SKEW_SEC)) return null;

    const userJson = fields.get('user');
    if (!userJson) return null;
    const user: unknown = JSON.parse(userJson);
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
    const u = user as Record<string, unknown>;
    if (typeof u.id !== 'number' || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
    if (u.is_bot === true) return null;

    return { telegramId: String(u.id), label: tgLabel(u) };
  } catch {
    return null;
  }
}
