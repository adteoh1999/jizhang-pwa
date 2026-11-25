// PostgREST 请求小工具（2e）。不打印回应内容或 token；出错只回状态码与 PostgREST 的 code。
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

// 上传栏位（本地专用的 dirty、sync_error 不送；user_id 由服务器默认 auth.uid() 补）
export const UPLOAD_COLUMNS = Object.freeze({
  transactions: Object.freeze(['id', 'kind', 'amount_minor', 'category_id', 'occurred_on', 'note', 'created_at', 'updated_at', 'deleted']),
  categories: Object.freeze(['id', 'kind', 'name', 'icon', 'sort', 'updated_at', 'deleted']),
});
const DEFAULT_TIMEOUT_MS = 15_000;
export const SELECT_TIMEOUT_MS = 20_000;
export const PAGE_SIZE = 1000;

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

// 值用双引号包、整段编码（时间里的 + 必须变 %2B，否则会被当空格）
const q = (v) => `%22${encodeURIComponent(String(v).replace(/[\\"]/g, '\\$&'))}%22`; // " 与 \ 前加反斜线（PostgREST 规则）

/**
 * 拉一页（2e-2）：依 (server_updated_at, id) 排序，每页 1000 列。
 * - after 有值（上一页最后一列的原字串）→ keyset：or=(gt ts, and(eq ts, id gt id))
 * - 否则 since 有值 → server_updated_at=gt.since（增量）；都没有 → 完整拉取
 * 回 {status, rows, errorCode}：rows 只有 2xx 且是清单才有；status 0 = 网络错或超时。
 */
export async function selectPage(fetchFn, table, { after = null, since = null } = {}, accessToken, { timeoutMs = SELECT_TIMEOUT_MS } = {}) {
  const cols = UPLOAD_COLUMNS[table];
  if (!cols) throw new Error(`未知的表：${table}`);
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${[...cols, 'server_updated_at'].join(',')}`
    + `&order=server_updated_at.asc,id.asc&limit=${PAGE_SIZE}`;
  if (after) {
    url += `&or=(server_updated_at.gt.${q(after.ts)},and(server_updated_at.eq.${q(after.ts)},id.gt.${q(after.id)}))`;
  } else if (since) {
    url += `&server_updated_at=gt.${encodeURIComponent(since)}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    const ok = res.status >= 200 && res.status < 300;
    const errorCode = !ok && body && typeof body.code === 'string' ? body.code : null;
    return { status: res.status, rows: ok && Array.isArray(body) ? body : null, errorCode };
  } catch {
    return { status: 0, rows: null, errorCode: null };
  } finally {
    clearTimeout(timer);
  }
}
