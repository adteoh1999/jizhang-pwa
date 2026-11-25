// 注册：检查 IP 和全站次数 → 已有账号直接回 200 → 站主免邀请码 → 否则扣邀请码 → 建账号。
// 扣码是按（码, 邮箱）记一笔「保留」，同一邮箱重试不会重复扣；建账号明确失败、复查也没有账号才退码。
import { normalizeEmail, normalizeInviteCode } from '../_shared/normalize.ts';
import { json, secretKey, rpc, adminHeaders, clientIp, corsHeaders } from '../_shared/http.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  adminTimeoutMs?: number;
};
type Check = { limited?: boolean; exists?: boolean; owner?: boolean };

// 日志只记「哪一步、状态码、错误代码」，绝不记邮箱、邀请码、key
const logFail = (step: string, detail: string) => console.error(`[register] ${step}: ${detail}`);

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
  } catch (e) {
    logFail('建账号', e instanceof Error ? e.name : '失败');
    return { kind: 'unknown' };
  }
  let data: any = null;
  try { data = await res.json(); } catch { /* 没有内容 */ }
  if (res.ok) return { kind: 'created', id: typeof data?.id === 'string' ? data.id : undefined };
  const code = String(data?.error_code ?? data?.code ?? '');
  logFail('建账号', `HTTP ${res.status} ${code.slice(0, 40)}`);
  if (res.status >= 500 || res.status === 408) return { kind: 'unknown' };  // 408 请求超时：结果不明
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
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: '服务器设定不完整' });
  }
  const call = (name: string, args: unknown) => rpc(deps.fetch, base, key, name, args);

  try {
    const ip = clientIp(req.headers);
    if (!ip) logFail('IP', '取不到 IP（这次只靠全站上限）');
    const check = (await call('svc_register_check', { p_email: email, p_ip: ip })) as Check;
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
        catch { logFail('记录使用', '失败（保留 15 分钟后自动当作已用）'); }
      }
      return reply(200, { ok: true });
    }
    // 「已存在」：可能是同一邮箱另一个请求刚建好，共用同一笔保留，不能退码
    if (result.kind === 'exists') return reply(200, { ok: true });

    // 失败或结果不明：先再查一次是否已建成（p_count=false：不记、不限流）
    try {
      const again = (await call('svc_register_check', { p_email: email, p_ip: null, p_count: false })) as Check;
      if (again?.exists) return reply(200, { ok: true });
    } catch {
      logFail('复查', '失败（不退码）');
      return reply(500, { error: '暂时无法注册，请稍后再试' });
    }
    // 只有「明确失败」才退码。结果不明（超时、5xx）时 Supabase 可能稍后才建好，一律不退：
    // 同一邮箱 15 分钟内重试会重用同一笔保留，不会多扣；没重试的话这个码作废（用户 2026-11-23 选的取舍）
    if (code && result.kind === 'failed') {
      try { await call('svc_refund_invite', { p_code: code, p_email: email }); } catch { logFail('退码', '失败（保留 15 分钟后当作已用）'); }
    }
    return reply(500, { error: '暂时无法注册，请稍后再试' });
  } catch (e) {
    logFail('rpc', e instanceof Error ? e.message : '失败');
    return reply(500, { error: '暂时无法注册，请稍后再试' });
  }
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleRegister(req, realDeps()));
