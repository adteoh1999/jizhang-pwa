// 用户身份与删除账号的共用小工具（delete-account、invites 共用）
// 打包规则：这个档不能 import 别档；顶层名字不能和 http.ts、normalize.ts、各函数的 index.ts 重复。

export type AuthUser = { id: string; email: string; kind: string };

// 用用户的 access token 问 Auth「这是谁」。
// 回传：{id, email（小写）, kind（app_metadata.kind，没有就 ''）}
//   'gone'          ：token 还没过期，但账号已经不存在（403 + error_code user_not_found；删号重试时会遇到）
//   'unauthorized'  ：token 无效、过期、被登出（401／其他 403）
//   'error'         ：其他失败（5xx、超时、内容坏掉、缺 id）
export async function getUser(
  fetchFn: typeof fetch, baseUrl: string, key: string, accessToken: string, timeoutMs = 3000,
): Promise<AuthUser | 'unauthorized' | 'gone' | 'error'> {
  let res: Response;
  let data: any = null;
  try {
    res = await fetchFn(`${baseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { data = await res.json(); } catch { data = null; }
  } catch {
    return 'error';
  }
  if (res.status === 401 || res.status === 403) {
    return data?.error_code === 'user_not_found' ? 'gone' : 'unauthorized';
  }
  if (!res.ok || !data || typeof data.id !== 'string' || data.id === '') return 'error';
  return {
    id: data.id,
    email: typeof data.email === 'string' ? data.email.toLowerCase() : '',
    kind: typeof data.app_metadata?.kind === 'string' ? data.app_metadata.kind : '',
  };
}

// 删除 Auth 账号（硬删）。2xx 或 404（早就不在了）→ true；其他、超时、连线失败 → false
export async function deleteAuthUser(
  fetchFn: typeof fetch, baseUrl: string, key: string, userId: string, timeoutMs = 5000,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: { apikey: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.body?.cancel(); } catch { /* 不需要内容 */ }
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// 取 Authorization: Bearer <token>；没有或格式不对回 null
export function bearer(req: Request): string | null {
  const m = (req.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}
