// 注册：检查 IP 次数 → 已有账号直接回 200 → 站主免邀请码 → 否则扣邀请码 → 建账号。
// 扣码是按（码, 邮箱）记一笔「保留」，同一邮箱重试不会重复扣；建账号失败就退码。
import { normalizeEmail, normalizeInviteCode } from '../_shared/normalize.ts';
import { json, secretKey, rpc, adminHeaders, clientIp } from '../_shared/http.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  adminTimeoutMs?: number;
};
type Check = { limited?: boolean; exists?: boolean; owner?: boolean };

const ALLOWED_ORIGINS = ['https://jizhang.adteoh.com', 'http://localhost:8000'];

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'content-type, apikey, authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

// 建账号的结果：created（建好了，带 id）、exists（早就有）、failed（明确失败）、unknown（超时或 5xx）
async function createUser(deps: Deps, base: string, key: string, email: string): Promise<{ kind: string; id?: string }> {
  let res: Response;
  try {
    res = await deps.fetch(`${base}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders(key),
      body: JSON.stringify({ email, email_confirm: true, app_metadata: { kind: 'email' } }),
      signal: AbortSignal.timeout(deps.adminTimeoutMs ?? 5000),
    });
  } catch {
    return { kind: 'unknown' };
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* 没有内容 */ }
  if (res.ok) return { kind: 'created', id: typeof data?.id === 'string' ? data.id : undefined };
  if (res.status >= 500) return { kind: 'unknown' };
  const code = String(data?.error_code ?? data?.code ?? '');
  const msg = String(data?.msg ?? data?.message ?? '');
  if (code === 'email_exists' || /already (been )?registered/i.test(msg)) return { kind: 'exists' };
  return { kind: 'failed' };
}

export async function handleRegister(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('Origin'));
  const reply = (status: number, obj: unknown) => json(status, obj, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  const email = normalizeEmail(input?.email);
  if (!email) return reply(400, { error: '邮箱格式不对' });

  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    return reply(500, { error: '服务器设定不完整' });
  }
  const call = (name: string, args: unknown) => rpc(deps.fetch, base, key, name, args);

  try {
    const check = (await call('svc_register_check', { p_email: email, p_ip: clientIp(req.headers) })) as Check;
    if (check?.limited) return reply(429, { error: '尝试太多次，请稍后再试' });
    if (check?.exists) return reply(200, { ok: true });

    let code = '';
    if (!check?.owner) {
      code = normalizeInviteCode(input?.invite_code);
      if (!code) return reply(403, { error: '需要有效的邀请码' });
      const okRedeem = await call('svc_redeem_invite', { p_code: code, p_email: email });
      if (okRedeem !== true) return reply(403, { error: '需要有效的邀请码' });
    }

    const result = await createUser(deps, base, key, email);
    if (result.kind === 'created') {
      if (code && result.id) {
        try { await call('svc_record_invite_use', { p_code: code, p_email: email, p_user_id: result.id }); }
        catch { /* 记录失败：保留 15 分钟后自动当作已用 */ }
      }
      return reply(200, { ok: true });
    }
    // 「已存在」：可能是同一邮箱另一个请求刚建好，共用同一笔保留，不能退码
    if (result.kind === 'exists') return reply(200, { ok: true });

    if (result.kind === 'unknown') {
      // 结果不明：再查一次是否已建成（不传 IP，不算次数）
      try {
        const again = (await call('svc_register_check', { p_email: email, p_ip: null })) as Check;
        if (again?.exists) return reply(200, { ok: true });
      } catch {
        return reply(500, { error: '暂时无法注册，请稍后再试' });  // 查不到就不退码，宁可让保留 15 分钟后过期
      }
    }
    if (code) {
      try { await call('svc_refund_invite', { p_code: code, p_email: email }); } catch { /* 退码失败：保留 15 分钟后当作已用 */ }
    }
    return reply(500, { error: '暂时无法注册，请稍后再试' });
  } catch {
    return reply(500, { error: '暂时无法注册，请稍后再试' });
  }
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleRegister(req, realDeps()));
