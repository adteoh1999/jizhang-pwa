// 用户关键词（3e）：AI 认完之后，文字、截图说明或店名含用户关键词，就一定记成那个分类。
// 规则（用户 2026-11-27）：不分大小写、包含即对上；英文／数字那一端要整个词（bus 不对上 business、12 不对上 12.50）；
// 对上好几个 → 最长的赢（同长按字串顺序，结果固定）；收支相同才套用；分类不在（已删除）跳过。
// 打包规则：这个档不能 import 别档；顶层名字一律 bot／BOT_ 开头。

export type BotKeyword = { keyword: string; categoryId: string };
type BotKwCat = { id: string; kind: 'expense' | 'income' };
type BotKwDraft = { kind: 'expense' | 'income'; categoryId: string; [k: string]: unknown };

const BOT_KW_MAX = 500;
const BOT_KW_WORD = /[a-z0-9]/;
const BOT_KW_DIGIT = /[0-9]/;

// 服务器回传（svc_bot_keywords）→ 清单。坏列跳过；关键词保留服务器原字串（App 存的已正规化；
// 别台设备 Unicode 规则不同也照收，比对时再各自转小写）。
export function botParseKeywords(server: unknown): BotKeyword[] {
  if (!Array.isArray(server)) return [];
  const out: BotKeyword[] = [];
  for (const r of server) {
    if (out.length >= BOT_KW_MAX) break;
    if (!r || typeof r !== 'object') continue;
    const { keyword, category_id } = r as Record<string, unknown>;
    if (typeof keyword !== 'string' || keyword === '' || typeof category_id !== 'string' || category_id === '') continue;
    out.push({ keyword, categoryId: category_id });
  }
  return out;
}

// 关键词某一端外面那个字元算不算「同一个词的接续」：英文字母／数字算；
// 数字端外面是 . 或 , 再接数字也算（12 不对上 12.50、1 不对上 1,200）。
function botKwContinues(src: string, at: number, step: 1 | -1, edge: string): boolean {
  const c = src[at];
  if (c === undefined) return false;
  if (BOT_KW_WORD.test(c)) return true;
  if (BOT_KW_DIGIT.test(edge) && (c === '.' || c === ',')) {
    const d = src[at + step];
    return d !== undefined && BOT_KW_DIGIT.test(d);
  }
  return false;
}

// 来源 src 里有没有关键词 k（都先转小写）。英文／数字那一端要整个词；中文等其他字元那一端照「包含就算」。
export function botKeywordHits(src: string, k: string): boolean {
  const s = src.toLowerCase();
  const kw = k.toLowerCase();
  if (kw === '') return false;
  const first = kw[0];
  const last = kw[kw.length - 1];
  for (let i = s.indexOf(kw); i >= 0; i = s.indexOf(kw, i + 1)) {
    const end = i + kw.length;
    if (BOT_KW_WORD.test(first) && botKwContinues(s, i - 1, -1, first)) continue;
    if (BOT_KW_WORD.test(last) && botKwContinues(s, end, 1, last)) continue;
    return true;
  }
  return false;
}

// 套用：sources＝文字讯息、截图说明、AI 原始店名（空字串略过）。回新的草稿（只换分类）与用了哪个关键词。
export function botApplyKeyword<D extends BotKwDraft>(
  draft: D, ctx: { sources: string[]; keywords: BotKeyword[]; cats: BotKwCat[] },
): { draft: D; keyword: string | null } {
  const srcs = ctx.sources.filter((x) => typeof x === 'string' && x !== '');
  const len = (x: string) => [...x].length;
  const ok = ctx.keywords
    .filter((k) => ctx.cats.some((c) => c.id === k.categoryId && c.kind === draft.kind))
    .sort((a, b) => len(b.keyword) - len(a.keyword) || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0));
  for (const k of ok) {
    if (srcs.some((s) => botKeywordHits(s, k.keyword))) return { draft: { ...draft, categoryId: k.categoryId }, keyword: k.keyword };
  }
  return { draft, keyword: null };
}
