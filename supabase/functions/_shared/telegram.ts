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
// 连接（tg-link bind）用的 initData 时效；tg-login 回 bindLeft 也用它算（用户选 10 分钟）
export const TG_BIND_MAX_SEC = 600;

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
export async function tgBotCallResult(
  fetchFn: typeof fetch, token: string | undefined, method: string, payload: unknown, timeoutMs = 5000,
): Promise<{ ok: true; result: unknown } | { ok: false; status: number }> {
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
    if (res.ok && data && data.ok === true) return { ok: true, result: data.result };
    return { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function tgBotCall(
  fetchFn: typeof fetch, token: string | undefined, method: string, payload: unknown, timeoutMs = 5000,
): Promise<{ ok: true } | { ok: false; status: number }> {
  const r = await tgBotCallResult(fetchFn, token, method, payload, timeoutMs);
  return r.ok ? { ok: true } : r;
}

// ---------- 3d：webhook 密钥、照片、下载、图片格式、base64 ----------

// webhook 的 secret_token：1–256 字、只能英数 _ -（我们要求至少 32 字）
export function tgSecretOk(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(s);
}

// 固定时间比较：两边各做 SHA-256 再逐位元组比，长度不同也不提早返回
export async function tgSecretEqual(a: unknown, b: unknown): Promise<boolean> {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// 长边上限：https://platform.claude.com/docs/en/build-with-claude/vision 「Resolution and token cost」表（2026-11-26 查证）
const TG_IMG_EDGE = 2576;
const TG_IMG_BYTES = 5 * 1024 * 1024;
const TG_FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;

function tgSizeOk(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && v >= 0 && v <= TG_IMG_BYTES);
}

// Message.photo（PhotoSize[]，官方没写排序）：挑长边 ≤ 2576、大小没写或 ≤ 5 MB 里面积最大的
export function tgPickPhoto(sizes: unknown): { fileId: string } | null {
  if (!Array.isArray(sizes)) return null;
  let best: { fileId: string; area: number } | null = null;
  for (const p of sizes) {
    if (!p || typeof p !== 'object') continue;
    const { file_id, width, height, file_size } = p as Record<string, unknown>;
    if (typeof file_id !== 'string' || !TG_FILE_ID.test(file_id)) continue;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)
        || width <= 0 || height <= 0) continue;
    if (Math.max(width, height) > TG_IMG_EDGE || !tgSizeOk(file_size)) continue;
    if (!best || width * height > best.area) best = { fileId: file_id, area: width * height };
  }
  return best ? { fileId: best.fileId } : null;
}

// 当「档案」传的图片：mime_type 只用来先筛（传的人自己说的），真正格式看档头
export function tgImageDoc(doc: unknown): { fileId: string } | null {
  if (!doc || typeof doc !== 'object') return null;
  const { file_id, mime_type, file_size } = doc as Record<string, unknown>;
  if (typeof file_id !== 'string' || !TG_FILE_ID.test(file_id)) return null;
  if (mime_type !== 'image/jpeg' && mime_type !== 'image/png' && mime_type !== 'image/webp') return null;
  return tgSizeOk(file_size) ? { fileId: file_id } : null;
}

// getFile → 下载（网址含 token：任何错误都吞掉、不回讯息；不跟转址；边读边算，超过上限就中止）
export async function tgDownload(
  fetchFn: typeof fetch, token: string | undefined, fileId: string, maxBytes: number, timeoutMs: number,
): Promise<Uint8Array | null> {
  if (!tgBotTokenOk(token) || typeof fileId !== 'string' || !TG_FILE_ID.test(fileId)) return null;
  const deadline = Date.now() + timeoutMs;
  const meta = await tgBotCallResult(fetchFn, token, 'getFile', { file_id: fileId }, Math.max(1, Math.min(5000, timeoutMs)));
  if (!meta.ok) return null;
  const path = (meta.result as any)?.file_path;
  if (typeof path !== 'string' || !/^[A-Za-z0-9_./-]{1,256}$/.test(path) || path.includes('..')) return null;
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    const res = await fetchFn(`https://api.telegram.org/file/bot${token.trim()}/${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(left),
    });
    if (!res.ok || !res.body) return null;
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) return null;
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes || Date.now() > deadline) {   // 不只靠执行环境的 AbortSignal：自己也看时间
        try { await reader.cancel(); } catch { /* 不管 */ }
        return null;
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  } catch {
    return null;
  }
}

// 看档头认图片格式（不信副档名与 mime_type）
export function tgSniffImage(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// base64：每块 32766 bytes（3 的倍数，块与块之间才不会多出 =），省 CPU（Edge Function 每次只有 2 秒 CPU）
export function tgBase64(b: Uint8Array): string {
  const CHUNK = 32766;
  let out = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    out += btoa(String.fromCharCode.apply(null, b.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return out;
}

// ---------- 用户决定 8：送 AI 前去掉图片里的拍摄资料（GPS、相机、注解等） ----------
// 只拆档案结构、不重新压缩（影像资料原样保留）。结构坏掉一律回 null（当成「图片读不了」，不把原档送出去）。
//   JPEG：留 APP0（JFIF）、APP2（ICC 色彩）、APP14（Adobe 色彩转换）与所有非 APP 区段；其他 APPn（EXIF／XMP 在 APP1、
//         IPTC 在 APP13）和 COM 注解拿掉。扫描之间的区段照同样规则；EOI 之后（动态照片影片、第二张图等）全部丢掉；
//         没有 EOI（被截断）就把影像资料抄到档尾。
//   PNG ：白名单，只留看图需要的区块；IEND 之后的东西丢掉。
//   WebP：白名单（VP8／VP8L／VP8X／ALPH／ICCP／ANIM／ANMF），VP8X 的 EXIF／XMP 旗标清掉，RIFF 大小重算。
const TG_PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'cICP']);
const TG_WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF']);

export function tgStripMeta(b: Uint8Array, mediaType: string): Uint8Array | null {
  if (!(b instanceof Uint8Array) || tgSniffImage(b) !== mediaType) return null;
  if (mediaType === 'image/jpeg') return tgStripJpeg(b);
  if (mediaType === 'image/png') return tgStripPng(b);
  if (mediaType === 'image/webp') return tgStripWebp(b);
  return null;
}

function tgJoin(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

const tgU32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const tgU32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// 逐段走 JPEG；每段回 { m, at（marker 前那个 FF 的位置）, i（长度栏位）, end }。SOS 之后的影像资料跳到下一个真正的 marker。
// onSeg 回 false 就停。结构坏掉回 false；正常走完（EOI 或档尾）回 true。
function tgWalkJpeg(
  b: Uint8Array,
  onSeg: (m: number, at: number, i: number, end: number) => boolean | void,
  onData: (from: number, to: number) => void,
): boolean {
  let i = 2;
  let sawSos = false;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return false;
    while (i < b.length && b[i] === 0xff) i++;          // 填充用的 FF
    if (i >= b.length) return false;
    const m = b[i];
    const at = i - 1;
    i++;
    if (m === 0xd9) {
      if (!sawSos) return false;
      onSeg(m, at, i, i);
      return true;
    }
    if (m === 0xd8 || m === 0x00) return false;
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {         // 没有长度的 marker
      if (onSeg(m, at, i, i) === false) return true;
      continue;
    }
    if (i + 2 > b.length) return false;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) return false;
    const end = i + len;
    if (onSeg(m, at, i, end) === false) return true;
    i = end;
    if (m === 0xda) {
      sawSos = true;
      // 影像资料：一直到下一个不是 FF00、不是 RST、不是填充 FF 的 marker
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && b[j + 1] !== 0xff && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) {                            // 没有 EOI（被截断）：抄到档尾
        onData(i, b.length);
        return true;
      }
      let k = j;
      while (k > i && b[k - 1] === 0xff) k--;            // 影像资料里的 FF 后面一定跟 00；marker 前多出来的 FF 是填充
      onData(i, k);
      i = j;
    }
  }
}

function tgStripJpeg(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  const ok = tgWalkJpeg(b, (m, at, _i, end) => {
    const isApp = m >= 0xe0 && m <= 0xef;
    const keep = isApp ? (m === 0xe0 || m === 0xe2 || m === 0xee) : m !== 0xfe;
    if (keep) parts.push(b.subarray(at, end));
  }, (from, to) => { parts.push(b.subarray(from, to)); });
  return ok ? tgJoin(parts) : null;
}

function tgStripPng(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const end = i + 12 + tgU32be(b, i);
    if (end > b.length) return null;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (TG_PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    if (type === 'IEND') return tgJoin(parts);
    i = end;
  }
  return null;
}

// 走 WebP 的区块（长度一律当无号数）；坏掉回 false
function tgWalkWebp(b: Uint8Array, onChunk: (cc: string, i: number, end: number) => void): boolean {
  if (b.length < 12) return false;
  const riffEnd = 8 + tgU32le(b, 4);
  if (riffEnd > b.length || riffEnd < 12) return false;
  let i = 12;
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return false;
    const size = tgU32le(b, i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > riffEnd) return false;
    onChunk(String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]), i, end);
    i = end;
  }
  return true;
}

function tgStripWebp(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  const ok = tgWalkWebp(b, (cc, i, end) => {
    if (!TG_WEBP_KEEP.has(cc)) return;
    if (cc === 'VP8X' && end - i >= 9) {
      const c = b.slice(i, end);
      c[8] &= ~0x0c;                                      // 清掉 EXIF（0x08）、XMP（0x04）旗标
      parts.push(c);
    } else {
      parts.push(b.subarray(i, end));
    }
  });
  if (!ok) return null;
  const body = tgJoin(parts);
  const n = body.byteLength + 4;
  return tgJoin([new Uint8Array([0x52, 0x49, 0x46, 0x46, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255,
    0x57, 0x45, 0x42, 0x50]), body]);
}

// 读图的宽高（审核 S3：Anthropic 单张上限 8000x8000 px，超过会回 400）。读不到回 null。
//   JPEG：第一个 SOFn（C0–CF，C4／C8／CC 除外）；PNG：IHDR；WebP：VP8X 画布、VP8 关键帧标头、VP8L 标头。
export function tgImageSize(b: Uint8Array, mediaType: string): { w: number; h: number } | null {
  if (!(b instanceof Uint8Array) || tgSniffImage(b) !== mediaType) return null;
  let out: { w: number; h: number } | null = null;
  if (mediaType === 'image/jpeg') {
    tgWalkJpeg(b, (m, _at, i, end) => {
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (end - i >= 7) out = { h: (b[i + 3] << 8) | b[i + 4], w: (b[i + 5] << 8) | b[i + 6] };
        return false;
      }
      if (m === 0xda) return false;
    }, () => {});
  } else if (mediaType === 'image/png') {
    if (b.length >= 24 && tgU32be(b, 8) >= 8 && String.fromCharCode(b[12], b[13], b[14], b[15]) === 'IHDR') {
      out = { w: tgU32be(b, 16), h: tgU32be(b, 20) };
    }
  } else if (mediaType === 'image/webp') {
    let first = true;
    tgWalkWebp(b, (cc, i, end) => {
      if (!first) return;
      first = false;
      const d = i + 8;
      const n = end - d;
      if (cc === 'VP8X' && n >= 10) {
        out = { w: 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16)), h: 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16)) };
      } else if (cc === 'VP8 ' && n >= 10 && b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) {
        out = { w: (b[d + 6] | (b[d + 7] << 8)) & 0x3fff, h: (b[d + 8] | (b[d + 9] << 8)) & 0x3fff };
      } else if (cc === 'VP8L' && n >= 5 && b[d] === 0x2f) {
        const bits = tgU32le(b, d + 1);
        out = { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
    });
  }
  const r = out as { w: number; h: number } | null;
  return r && r.w > 0 && r.h > 0 ? r : null;
}
