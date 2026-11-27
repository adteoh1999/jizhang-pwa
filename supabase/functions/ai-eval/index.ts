// 临时的测试图评估函数（2026-11-27，用户要求用假的付款截图测 AI 准确率）。
// 用服务器上的 ANTHROPIC_API_KEY 跑「跟 bot 完全一样」的流程：认图 → 去拍摄资料 → 读宽高 → 组请求（内建分类）→ AI → 程式检查。
// 不碰资料库、不记账、不记日志内容。只认 X-Eval-Token（AI_EVAL_TOKEN，固定时间比较）。
// 用完就从远端删掉函数与 AI_EVAL_TOKEN（docs/admin.md）。部署要 --no-verify-jwt。
// 打包规则：这个档自己的顶层名字一律 ev／EV_ 开头。
import { tgSecretOk, tgSecretEqual, tgSniffImage, tgStripMeta, tgImageSize, tgBase64 } from '../_shared/telegram.ts';
import { BOT_DEFAULT_CATEGORIES } from '../_shared/bot-categories.ts';
import { botCheckExtraction } from '../_shared/bot-extract.ts';
import { aiKeyOk, aiBuildRequest, aiExtract } from '../_shared/ai-extract.ts';

type EvDeps = { env: (k: string) => string | undefined; fetch: typeof fetch };

const EV_B64_MAX = 8 * 1024 * 1024;
const EV_EDGE = 8000;
const EV_AI_MS = 25000;
const evJson = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleAiEval(req: Request, deps: EvDeps): Promise<Response> {
  try {
    if (req.method !== 'POST') return evJson(405, { error: 'method' });
    const token = deps.env('AI_EVAL_TOKEN');
    if (!tgSecretOk(token)) return evJson(500, { error: 'config' });
    if (!(await tgSecretEqual(req.headers.get('X-Eval-Token'), token))) return evJson(401, { error: 'token' });
    const key = deps.env('ANTHROPIC_API_KEY');
    if (!aiKeyOk(key)) return evJson(500, { error: 'ai_key' });

    let body: any;
    try { body = await req.json(); } catch { return evJson(400, { error: 'json' }); }
    const today = body?.today;
    const caption = typeof body?.caption === 'string' ? body.caption.slice(0, 500) : '';
    if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return evJson(400, { error: 'today' });
    if (typeof body.image !== 'string' || body.image.length > EV_B64_MAX) return evJson(400, { error: 'image_size' });

    let raw: Uint8Array;
    try {
      const bin = atob(body.image);
      raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    } catch {
      return evJson(400, { error: 'image_b64' });
    }
    const mediaType = tgSniffImage(raw);
    const bytes = mediaType ? tgStripMeta(raw, mediaType) : null;
    const size = bytes && mediaType ? tgImageSize(bytes, mediaType) : null;
    if (!bytes || !mediaType || !size || Math.max(size.w, size.h) > EV_EDGE) return evJson(200, { error: 'image_bad' });

    const cats = BOT_DEFAULT_CATEGORIES.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
    const started = Date.now();
    const ai = await aiExtract(deps.fetch, key, aiBuildRequest({ today, cats, caption, image: { mediaType, base64: tgBase64(bytes) } }), EV_AI_MS);
    const ms = Date.now() - started;
    if (!ai.ok) return evJson(200, { ai_error: ai.why === 'http' ? { why: ai.why, status: ai.status, ...(ai.errType ? { errType: ai.errType } : {}) } : { why: ai.why }, ms });
    const check = botCheckExtraction(ai.data, { source: 'photo', text: '', caption, today, cats });
    return evJson(200, { ai: ai.data, check, usage: ai.usage ?? null, ms });
  } catch {
    return evJson(500, { error: 'unexpected' });
  }
}

function evRealDeps(): EvDeps {
  const D = (globalThis as any).Deno;
  return { env: (k) => D.env.get(k), fetch: (input: any, init?: any) => fetch(input, init) };
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleAiEval(req, evRealDeps()));
