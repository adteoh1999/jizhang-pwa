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
// 平台会在哪个 header、哪一段放真正的 IP，要部署临时函数 whoami 实测后才定案（计划 2c-4）；
// 定案前一律回 null → 注册跳过 IP 限流（邀请码 31^8 种组合，猜不到）。
export function clientIp(_headers: Headers): string | null {
  return null;
}
