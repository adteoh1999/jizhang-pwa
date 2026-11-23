// 回应、密钥、rpc 调用等共用小工具

export function json(status: number, obj: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// 先读新版 SUPABASE_SECRET_KEYS（JSON，取 default，没有就取第一个），再退回旧的 SUPABASE_SERVICE_ROLE_KEY
// （后备路径未实测：旧版 JWT key 只放 apikey 时，PostgREST 可能不认，rpc 会失败——失败即拒绝，不会误放行）
export function secretKey(env: (k: string) => string | undefined): string {
  const raw = env('SUPABASE_SECRET_KEYS');
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      const v = obj && typeof obj === 'object' ? (obj.default ?? Object.values(obj)[0]) : undefined;
      if (typeof v === 'string' && v) return v;
    } catch { /* 坏掉就退回旧变数 */ }
  }
  const old = env('SUPABASE_SERVICE_ROLE_KEY');
  if (old) return old;
  throw new Error('找不到 secret key');
}

// 呼叫 /auth/v1/admin/* 用的 header
export function adminHeaders(key: string): Record<string, string> {
  return { apikey: key, 'Content-Type': 'application/json' };
}

// 调用 svc schema 的函数；非 2xx、超时、内容坏掉就 throw。
// 抛出的讯息一律是自己写的固定文字（函数名 + 状态码或错误种类），不会带出 key 或回应内容，可以放心写进日志。
export async function rpc(
  fetchFn: typeof fetch, baseUrl: string, key: string, name: string, args: unknown, timeoutMs = 1000,
): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Profile': 'svc', 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`rpc ${name} 失败：${e instanceof Error ? e.name : '连线错误'}`);
  }
  if (!res.ok) throw new Error(`rpc ${name} 失败：HTTP ${res.status}`);
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`rpc ${name} 失败：回传内容不是 JSON`);
  }
}

// 取用户 IP（给注册的 IP 限流用）。
// 2026-11-23 实测：Supabase 前面是 Cloudflare。cf-connecting-ip 由 Cloudflare 填入，
// 用户自己送这个 header 会被 Cloudflare 直接拒绝（403），所以可信；
// x-forwarded-for 会被平台重写，true-client-ip 会原样透传（能伪造），都不用。
// 前提是请求只能经 Cloudflare 进来；这是实测结果、不是文件承诺，平台改架构后要重测。
// 这里只做粗筛，真正的格式检查和 IPv6 按 /64 归并在数据库 svc_register_check 里做。
// 没有这个 header、或格式不像 IP，就回 null → 这次跳过 IP 限流（全站上限和邀请码仍然有效）。
export function clientIp(headers: Headers): string | null {
  const v = (headers.get('cf-connecting-ip') ?? '').trim().toLowerCase();
  if (v.length > 45) return null;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return m.slice(1).every((x) => Number(x) <= 255) ? v : null;
  if ((v.match(/:/g) ?? []).length >= 2 && /^[0-9a-f:.]+$/.test(v)) return v;
  return null;
}
