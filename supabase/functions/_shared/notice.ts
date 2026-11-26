// 「已连接 Telegram」通知信（tg-link bind 成功时寄；寄失败的话 tg-login 下次打开时补寄）
// 打包规则：这个档不能 import 别档；顶层名字一律 notice 开头（不分大小写），免得和其他 _shared 档、index.ts 撞名。
// 信里不放 Telegram 名字（名字是对方自己填的，可以拿来钓鱼；用户 2026-11-26 选 B），只寄纯文字。
// 不 throw、不记日志：回传结果种类（都是固定文字，可以直接写进日志）。

export const NOTICE_SUBJECT = '你的记账已连接 Telegram';
export const NOTICE_TEXT = '一个 Telegram 账号刚刚连接到你的记账账号。如果不是你本人操作，请到记账 App 设置里按「解除 Telegram 连接」。';

// 预约（svc_tg_notify_reserve：同一个连接只寄一次、每个账号 24 小时最多 3 封）→ 寄 → 寄失败就撤回（svc_tg_notify_release）。
// call：呼叫端包好的 rpc（name, args, timeoutMs）；budget(cap)：这一步可以用的毫秒数（tg-login 会用剩下的总时间缩短）。
// 回传：'sent' | 'skip' | 'limited' | 'no-email' | 'no-config' | 'reserve-error' | 'bad-reserve' | 'mail-failed …' （寄失败时后面接撤回结果）
// 幂等键：预约回传这次连接的 linked_at → Idempotency-Key = sha256(「jizhang-link-notice:telegram_id:user_id:linked_at」)。
//   同一次连接永远同一个键：Resend 超时但其实已收下，下次补寄时 Resend 不会再寄（键保留 24 小时）；
//   解除后重新连接 linked_at 不同 → 换键，新连接的通知不会被吞掉。键是杂凑，不含个人资料。
//   来源：https://resend.com/docs/dashboard/emails/idempotency-keys（2026-11-26 查证：header Idempotency-Key、1–256 字、24 小时）
export async function noticeLinkedOnce(
  call: (name: string, args: unknown, timeoutMs: number) => Promise<unknown>,
  fetchFn: typeof fetch, env: (k: string) => string | undefined,
  telegramId: number, userId: string, email: string,
  budget: { rpcMs: number; mailMs: number; at: (cap: number) => number },
): Promise<string> {
  if (!email) return 'no-email';
  if (!env('RESEND_API_KEY') || !env('EMAIL_FROM')) return 'no-config'; // 先看设定，免得每次都预约又撤回
  let r: any;
  try {
    r = await call('svc_tg_notify_reserve', { p_telegram_id: telegramId, p_user_id: userId }, budget.at(budget.rpcMs));
  } catch {
    return 'reserve-error';
  }
  if (r?.do === 'skip') return 'skip';
  if (r?.do === 'limited') return 'limited';
  if (r?.do !== 'send' || !Number.isSafeInteger(r.id)) return 'bad-reserve';

  const idemKey = typeof r.linked_at === 'string' && r.linked_at !== ''
    ? await noticeHash(`jizhang-link-notice:${telegramId}:${userId}:${r.linked_at}`) : null;
  const sent = await noticeSend(fetchFn, env, email, budget.at(budget.mailMs), idemKey);
  if (sent === 'ok') return 'sent';
  try {
    await call('svc_tg_notify_release', { p_id: r.id, p_telegram_id: telegramId }, budget.at(budget.rpcMs));
    return `mail-failed ${sent}（已撤回）`;
  } catch {
    return `mail-failed ${sent}（撤回失败）`;
  }
}

// 用 Resend 寄纯文字信（照 send-email 的写法）。回 'ok'，或失败种类（'no-config'、'HTTP 500'、错误名称）
async function noticeHash(s: string): Promise<string | null> {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function noticeSend(
  fetchFn: typeof fetch, env: (k: string) => string | undefined, email: string, timeoutMs: number, idemKey: string | null,
): Promise<string> {
  const resendKey = env('RESEND_API_KEY') ?? '';
  const from = env('EMAIL_FROM') ?? '';
  if (!resendKey || !from) return 'no-config';
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json',
        ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
      },
      body: JSON.stringify({ from, to: [email], subject: NOTICE_SUBJECT, text: NOTICE_TEXT }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.body?.cancel(); } catch { /* 不需要内容 */ }
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.name : '连线错误';
  }
}
