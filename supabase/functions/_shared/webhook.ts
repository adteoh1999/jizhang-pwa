// Standard Webhooks 签名验证（Supabase Auth 钩子用这个格式），只用 Web Crypto

const WEBHOOK_TOLERANCE_SEC = 300;
const WEBHOOK_MIN_KEY_BYTES = 16;  // 贴错（例如只剩前缀）就直接拒绝

function webhookB64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 检查 secret 格式（贴错时给日志用，不会印出内容）
export function webhookKeyOk(secret: string): boolean {
  try {
    return webhookB64(secret.replace(/^v1,/, '').replace(/^whsec_/, '')).length >= WEBHOOK_MIN_KEY_BYTES;
  } catch {
    return false;
  }
}

// secret 格式 v1,whsec_<base64>；签名内容「id.timestamp.body」；
// webhook-signature 可能有多个（空白隔开），任一相符即可；时间差超过 300 秒不收
export async function verifyWebhook(secret: string, headers: Headers, body: string, nowSec: number): Promise<boolean> {
  try {
    const id = headers.get('webhook-id');
    const ts = headers.get('webhook-timestamp');
    const sigs = headers.get('webhook-signature');
    if (!id || !ts || !sigs || !/^\d+$/.test(ts)) return false;
    if (Math.abs(nowSec - Number(ts)) > WEBHOOK_TOLERANCE_SEC) return false;

    const keyBytes = webhookB64(secret.replace(/^v1,/, '').replace(/^whsec_/, ''));
    if (keyBytes.length < WEBHOOK_MIN_KEY_BYTES) return false;
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${id}.${ts}.${body}`);

    for (const part of sigs.split(' ')) {
      const [ver, b64] = part.split(',');
      if (ver !== 'v1' || !b64) continue;
      let sig;
      try { sig = webhookB64(b64); } catch { continue; }
      // subtle.verify 本身是固定时间比较
      if (await crypto.subtle.verify('HMAC', key, sig, data)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
