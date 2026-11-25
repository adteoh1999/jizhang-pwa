// PostgREST 请求小工具（2e）。不打印回应内容或 token；出错只回状态码与 PostgREST 的 code。
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// 上传栏位（本地专用的 dirty、sync_error 不送；user_id 由服务器默认 auth.uid() 补）
export const UPLOAD_COLUMNS = Object.freeze({
  transactions: Object.freeze(['id', 'kind', 'amount_minor', 'category_id', 'occurred_on', 'note', 'created_at', 'updated_at', 'deleted']),
  categories: Object.freeze(['id', 'kind', 'name', 'icon', 'sort', 'updated_at', 'deleted']),
});
const DEFAULT_TIMEOUT_MS = 15_000;

const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row[c]]));

/**
 * upsert（服务器端 trigger 决定最后修改者胜；较旧的会被略过、不在回传里）。
 * 回 {status, rows, errorCode}：rows 只有 id、updated_at（成功才有）；status 0 = 网络错或超时。
 */
export async function upsertRows(fetchFn, table, rows, accessToken, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cols = UPLOAD_COLUMNS[table];
  if (!cols) throw new Error(`未知的表：${table}`);
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=user_id,id&columns=${cols.join(',')}&select=id,updated_at`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(rows.map((r) => pick(r, cols))),
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    const ok = res.status >= 200 && res.status < 300;
    const errorCode = !ok && body && typeof body.code === 'string' ? body.code : null;
    // rows：2xx 且回应是清单才有；2xx 但不是清单 → null（呼叫者当失败，不能当全部成功）
    return { status: res.status, rows: ok && Array.isArray(body) ? body : null, errorCode };
  } catch {
    return { status: 0, rows: null, errorCode: null };
  } finally {
    clearTimeout(timer);
  }
}
