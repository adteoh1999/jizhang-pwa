// 站主管理邀请码（2f）：check、list、create、set_active、uses、remove_user。
// 身份：用 access token 问 Auth 是谁；只有「邮箱登录（kind = email）且是站主邮箱」才能管理。
// check 对非站主回 200 {owner:false}（前端每天问一次，不想在 console 留错误）；其他动作回 403。
import { json, secretKey, rpc, corsHeaders } from '../_shared/http.ts';
import { getUser, deleteAuthUser, bearer } from '../_shared/user.ts';
import { normalizeInviteCode } from '../_shared/normalize.ts';

type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  adminTimeoutMs?: number;
};
type UseRow = {
  id: number; user_id: string | null; email: string; used_at: string;
  deleted: boolean; owner: boolean; pending: boolean;
};

const FAIL_MSG = '暂时无法完成，请稍后再试';
const RPC_MS = 3000;
const VALID_DAYS = [1, 7, 30, null];
const NOTE_MAX = 40;

// 日志只记「哪一步、状态码或错误种类」，绝不记邮箱、邀请码、token、key、user id
const logFail = (step: string, detail: string) => console.error(`[invites] ${step}: ${detail}`);

export async function handleInvites(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('Origin'));
  const reply = (status: number, obj: unknown) => json(status, obj, cors);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: '只接受 POST' });

  const token = bearer(req);
  if (!token) return reply(401, { error: '请重新登录后再试' });

  let input: any;
  try { input = await req.json(); } catch { input = null; }
  const action = input && typeof input === 'object' && typeof input.action === 'string' ? input.action : '';
  if (!['check', 'list', 'create', 'set_active', 'uses', 'remove_user'].includes(action)) {
    return reply(400, { error: '看不懂这个请求' });
  }

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
  const call = (name: string, args: unknown, ms = RPC_MS) => rpc(deps.fetch, base, key, name, args, ms);

  const user = await getUser(deps.fetch, base, key, token);
  if (user === 'gone' || user === 'unauthorized') return reply(401, { error: '请重新登录后再试' });
  if (user === 'error') {
    logFail('查身份', '失败');
    return reply(500, { error: FAIL_MSG });
  }

  try {
    const owner = user.kind === 'email' && (await call('svc_is_owner', { p_email: user.email })) === true;
    if (!owner) {
      return action === 'check' ? reply(200, { owner: false }) : reply(403, { error: '没有权限' });
    }

    switch (action) {
      case 'check':
        return reply(200, { owner: true });

      case 'list': {
        const list = await call('svc_invites_list', {});
        if (!Array.isArray(list)) throw new Error('svc_invites_list 回传不是阵列');
        return reply(200, { invites: list });
      }

      case 'create': {
        const maxUses = input.max_uses;
        const note = input.note ?? '';
        const okUses = Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 20;
        const okDays = 'days' in input && VALID_DAYS.includes(input.days);
        const okNote = typeof note === 'string' && [...note].length <= NOTE_MAX;
        if (!okUses || !okDays || !okNote) return reply(400, { error: '设定不正确' });
        const code = await call('svc_new_invite_code', { p_max_uses: maxUses, p_days: input.days, p_note: note });
        if (typeof code !== 'string' || !normalizeInviteCode(code)) throw new Error('svc_new_invite_code 回传格式不对');
        return reply(200, { code });
      }

      case 'set_active': {
        const code = normalizeInviteCode(input.code);
        if (!code) return reply(404, { error: '找不到这个邀请码' });
        if (typeof input.active !== 'boolean') return reply(400, { error: '设定不正确' });
        const found = await call('svc_invite_set_active', { p_code: code, p_active: input.active });
        return found === true ? reply(200, { ok: true }) : reply(404, { error: '找不到这个邀请码' });
      }

      case 'uses': {
        const code = normalizeInviteCode(input.code);
        if (!code) return reply(404, { error: '找不到这个邀请码' });
        const rows = await usesOf(call, code);
        // 前端不需要 user_id，不送出去
        return reply(200, {
          uses: rows.map((u) => ({
            id: u.id, email: u.email, used_at: u.used_at, deleted: u.deleted, owner: u.owner, pending: u.pending,
          })),
        });
      }

      case 'remove_user': {
        const code = normalizeInviteCode(input.code);
        if (!code) return reply(404, { error: '找不到这个邀请码' });
        const useId = input.use_id;
        if (!Number.isSafeInteger(useId) || useId < 1) return reply(400, { error: '设定不正确' });
        // 只能移除「用这个码注册的人」：从这个码的使用明细里找
        const row = (await usesOf(call, code)).find((u) => u.id === useId);
        if (!row || row.deleted || row.pending || !row.user_id) return reply(404, { error: '找不到这个用户' });
        if (row.owner || row.user_id === user.id) return reply(403, { error: '不能移除站主' });
        await call('svc_delete_user_data', { p_user_id: row.user_id }, 5000);
        if (!(await deleteAuthUser(deps.fetch, base, key, row.user_id, deps.adminTimeoutMs ?? 5000))) {
          logFail('删账号', '失败（资料已删，再按一次会接着删账号）');
          return reply(500, { error: FAIL_MSG });
        }
        return reply(200, { ok: true });
      }
    }
    return reply(400, { error: '看不懂这个请求' });
  } catch (e) {
    logFail(action, e instanceof Error ? e.message : '失败');
    return reply(500, { error: FAIL_MSG });
  }
}

async function usesOf(call: (name: string, args: unknown) => Promise<unknown>, code: string): Promise<UseRow[]> {
  const rows = await call('svc_invite_uses', { p_code: code });
  if (!Array.isArray(rows)) throw new Error('svc_invite_uses 回传不是阵列');
  return rows as UseRow[];
}

function realDeps(): Deps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleInvites(req, realDeps()));
