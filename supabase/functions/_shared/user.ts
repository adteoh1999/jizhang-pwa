// 用户身份、删除账号、Telegram 登录的共用小工具（delete-account、invites、tg-login、tg-link 共用）
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

// ---------------- 3b：Telegram 登录用（tg-login、tg-link） ----------------
// 下面这些都不 throw、不记日志（hashed_token、action_link、token、邮箱都不能进日志）。

// 用 admin API 依 user id 查账号（tg-login 凭 telegram_id 找到 user_id 之后用）。
// 回传 {email（小写，没有就 ''）, kind（app_metadata.kind，没有就 ''）}；404 → 'gone'；其他失败或 id 对不上 → 'error'
export async function adminGetUser(
  fetchFn: typeof fetch, baseUrl: string, key: string, userId: string, timeoutMs = 3000,
): Promise<{ email: string; kind: string } | 'gone' | 'error'> {
  try {
    const res = await fetchFn(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: { apikey: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 404) return 'gone';
    if (!res.ok || !data || data.id !== userId) return 'error';
    return {
      email: typeof data.email === 'string' ? data.email.toLowerCase() : '',
      kind: typeof data.app_metadata?.kind === 'string' ? data.app_metadata.kind : '',
    };
  } catch {
    return 'error';
  }
}

// 叫 /auth/v1/logout?scope=…（用用户自己的 token）；2xx → true，其他、超时、连线失败 → false
async function authLogoutScope(
  fetchFn: typeof fetch, baseUrl: string, key: string, accessToken: string, scope: 'local' | 'others', timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}/auth/v1/logout?scope=${scope}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.body?.cancel(); } catch { /* 不需要内容 */ }
    return res.ok;
  } catch {
    return false;
  }
}

// 作废这一个 session（只登出这个 token 自己）
export function revokeSession(
  fetchFn: typeof fetch, baseUrl: string, key: string, accessToken: string, timeoutMs = 3000,
): Promise<boolean> {
  return authLogoutScope(fetchFn, baseUrl, key, accessToken, 'local', timeoutMs);
}

// 登出这个账号的其他所有 session（自己这个不受影响）。3a-3／3b-1 实测：被登出的那边换新凭证马上失效，
// 但已发出的 access token 到期前（最多 1 小时）仍能读写资料。
export function logoutOthers(
  fetchFn: typeof fetch, baseUrl: string, key: string, accessToken: string, timeoutMs = 3000,
): Promise<boolean> {
  return authLogoutScope(fetchFn, baseUrl, key, accessToken, 'others', timeoutMs);
}

export type MintedSession = { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email: string } };

// 不寄信、不用验证码，替 expectedUserId 这个账号铸一个新 session（tg-login 用）。
// 做法（3b-1 实测，2026-11-26）：admin generate_link（magiclink）→ 回应顶层的 id、verification_type 要对 →
// verify {type:'magiclink', token_hash}。generate_link 不叫寄信钩子，但会作废这个账号等待中的验证码、占用 60 秒寄信限制。
//   'mismatch'：generate_link 回的人不对（没叫 verify），或 verify 回来的人不对（已作废那个 session）
//   'limited' ：任一步 429
//   'error'   ：其他失败（内容不完整时若已拿到 access_token，先作废它）
export async function mintSession(
  fetchFn: typeof fetch, baseUrl: string, key: string, email: string, expectedUserId: string, timeoutMs = 5000,
): Promise<MintedSession | 'limited' | 'mismatch' | 'error'> {
  let hashed: string;
  try {
    const res = await fetchFn(`${baseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', email }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 429) return 'limited';
    if (!res.ok || !data || typeof data !== 'object') return 'error';
    if (data.id !== expectedUserId || data.verification_type !== 'magiclink') return 'mismatch';
    if (typeof data.hashed_token !== 'string' || data.hashed_token === '') return 'error';
    hashed = data.hashed_token;
  } catch {
    return 'error';
  }

  let s: any = null;
  try {
    const res = await fetchFn(`${baseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { s = await res.json(); } catch { s = null; }
    if (res.status === 429) return 'limited';
    if (!res.ok || !s || typeof s !== 'object') return 'error';
  } catch {
    return 'error';
  }

  const at = typeof s.access_token === 'string' && s.access_token !== '' ? s.access_token : null;
  if (!at) return 'error';
  if (s.user?.id !== expectedUserId) {
    await revokeSession(fetchFn, baseUrl, key, at);
    return 'mismatch';
  }
  if (typeof s.refresh_token !== 'string' || s.refresh_token === '' || typeof s.expires_in !== 'number' || !Number.isFinite(s.expires_in)) {
    await revokeSession(fetchFn, baseUrl, key, at);
    return 'error';
  }
  return {
    access_token: at,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    user: { id: expectedUserId, email: typeof s.user.email === 'string' ? s.user.email.toLowerCase() : '' },
  };
}
