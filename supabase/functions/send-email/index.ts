// Supabase Auth「Send Email Hook」：Auth 要寄验证码时会叫这里。
// 先验证签名 → 限流（svc_otp_reserve）→ 用 Resend 寄信；寄信失败就撤回那一笔（不算次数）。
// 回应规则（官方）：拒绝寄信回 429；签名错回 401；寄信失败回 500（不能回 503，会被重试）。
import { normalizeEmail } from '../_shared/normalize.ts';
import { verifyWebhook } from '../_shared/webhook.ts';
import { json, secretKey, rpc } from '../_shared/http.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  nowSec: () => number;
  resendTimeoutMs?: number;
};

const hookError = (status: number, message: string) => json(status, { error: { http_code: status, message } });

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function emailText(code: string): string {
  return `你的记账验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略这封信。`;
}

export function emailHtml(code: string): string {
  const c = escapeHtml(code);
  return `<!doctype html><html lang="zh"><body style="margin:0;padding:24px;background:#F2F6F8;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;color:#1C2B33">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 24px">
<p style="margin:0 0 12px;font-size:16px">你的记账验证码是：</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:600;letter-spacing:6px">${c}</p>
<p style="margin:0;font-size:14px;color:#5A6B75">10 分钟内有效。如果不是你本人操作，请忽略这封信。</p>
</div></body></html>`;
}

export async function handleSendEmail(req: Request, deps: Deps): Promise<Response> {
  const { env } = deps;
  let body: string;
  try {
    body = await req.text();
  } catch {
    return hookError(500, '读取失败');
  }

  const hookSecret = env('SEND_EMAIL_HOOK_SECRET');
  if (!hookSecret) return hookError(500, '服务器设定不完整');
  if (!(await verifyWebhook(hookSecret, req.headers, body, deps.nowSec()))) {
    return hookError(401, '签名不对');
  }

  let email = '';
  let token = '';
  let action = '';
  try {
    const p = JSON.parse(body);
    email = normalizeEmail(p?.user?.email);
    token = typeof p?.email_data?.token === 'string' ? p.email_data.token : '';
    action = String(p?.email_data?.email_action_type ?? '');
  } catch {
    return hookError(500, '资料格式不对');
  }
  if (action === 'email_change') return hookError(429, '不支持更换邮箱');
  if (!email || !token) return hookError(500, '资料不完整');

  let base: string;
  let key: string;
  let resendKey: string;
  let from: string;
  try {
    base = env('SUPABASE_URL') ?? '';
    key = secretKey(env);
    resendKey = env('RESEND_API_KEY') ?? '';
    from = env('EMAIL_FROM') ?? '';
    if (!base || !resendKey || !from) throw new Error('缺设定');
  } catch {
    return hookError(500, '服务器设定不完整');
  }

  // 1. 限流
  let reserved: { ok?: boolean; id?: number; message?: string };
  try {
    reserved = (await rpc(deps.fetch, base, key, 'svc_otp_reserve', { p_email: email })) as typeof reserved;
  } catch {
    return hookError(500, '暂时无法寄信，请稍后再试');
  }
  if (!reserved || reserved.ok !== true) {
    return hookError(429, reserved?.message || '请稍后再试');
  }

  // 2. 寄信
  let sent = false;
  try {
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject: '你的记账验证码', html: emailHtml(token), text: emailText(token) }),
      signal: AbortSignal.timeout(deps.resendTimeoutMs ?? 2500),
    });
    sent = res.ok;
  } catch {
    sent = false;
  }
  if (sent) return json(200, {});

  // 3. 寄信失败：撤回那一笔，让用户可以马上重试
  try {
    await rpc(deps.fetch, base, key, 'svc_otp_release', { p_id: reserved.id });
  } catch { /* 撤回失败最多多算一次，不影响回应 */ }
  return hookError(500, '寄信失败，请稍后再试');
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init), nowSec: () => Math.floor(Date.now() / 1000) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleSendEmail(req, realDeps()));
