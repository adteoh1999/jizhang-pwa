// 删除自己的账号和全部资料（2f）。
// 流程：用 access token 问 Auth 是谁 → svc_delete_user_data 删资料、清掉邀请码使用纪录上的邮箱 → 删 Auth 账号。
// 可以重试：资料删过再删没关系；账号已经不存在（上次删到一半）→ 直接回成功。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { getUser, deleteAuthUser, bearer } from '../_shared/user.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  adminTimeoutMs?: number;
};

const FAIL_MSG = '暂时无法删除，请稍后再试';

// 日志只记「哪一步、状态码或错误种类」，绝不记邮箱、token、key、user id
const logFail = (step: string, detail: string) => console.error(`[delete-account] ${step}: ${detail}`);

export async function handleDeleteAccount(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('Origin'));
  const reply = (status: number, obj: unknown) => json(status, obj, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  const token = bearer(req);
  if (!token) return reply(401, { error: '请重新登录后再试' });

  let base: string;
  let key: string;
  try {
    base = deps.env('SUPABASE_URL') ?? '';
    key = secretKey(deps.env);
    if (!base) throw new Error('缺设定');
  } catch {
    logFail('设定', '缺 SUPABASE_URL 或 secret key');
    return reply(500, { error: FAIL_MSG });
  }

  const user = await getUser(deps.fetch, base, key, token);
  if (user === 'gone') return reply(200, { ok: true });
  if (user === 'unauthorized') return reply(401, { error: '请重新登录后再试' });
  if (user === 'error') {
    logFail('查身份', '失败');
    return reply(500, { error: FAIL_MSG });
  }

  try {
    await rpc(deps.fetch, base, key, 'svc_delete_user_data', { p_user_id: user.id }, 5000);
  } catch (e) {
    logFail('删资料', e instanceof Error ? e.message : '失败');
    return reply(500, { error: FAIL_MSG });
  }

  if (!(await deleteAuthUser(deps.fetch, base, key, user.id, deps.adminTimeoutMs ?? 5000))) {
    logFail('删账号', '失败（资料已删，重试会接着删账号）');
    return reply(500, { error: FAIL_MSG });
  }
  return reply(200, { ok: true });
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleDeleteAccount(req, realDeps()));
