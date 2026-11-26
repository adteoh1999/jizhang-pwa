// bot 用的分类（3d）：内建分类＋这个人服务器上的分类。
// 内建分类必须与 App 的 js/model.js DEFAULT_CATEGORIES 相同（tests/bot-categories.test.js 会比对）。
// 打包规则：这个档不能 import 别档；顶层名字一律 bot／BOT_ 开头。

export type BotCat = { id: string; kind: 'expense' | 'income'; name: string; sort: number };

const botMk = (kind: 'expense' | 'income', list: [string, string][]): BotCat[] =>
  list.map(([id, name], sort) => Object.freeze({ id, kind, name, sort }));

export const BOT_DEFAULT_CATEGORIES: readonly BotCat[] = Object.freeze([
  ...botMk('expense', [['food', '餐饮'], ['transport', '交通'], ['shopping', '购物'],
    ['bills', '账单'], ['fun', '娱乐'], ['other', '其他']]),
  ...botMk('income', [['salary', '工资'], ['bonus', '奖金'], ['side', '副业'], ['other_income', '其他收入']]),
]);

// 服务器的列（svc_bot_categories 回传）合并到内建上：同 id 盖过、deleted 拿掉、坏列跳过。
// 排序：支出在前；同收支按 sort，再按 id。
export function botMergeCategories(server: unknown): BotCat[] {
  const map = new Map<string, BotCat | null>();
  for (const c of BOT_DEFAULT_CATEGORIES) map.set(c.id, { ...c });
  if (Array.isArray(server)) {
    for (const r of server) {
      if (!r || typeof r !== 'object') continue;
      const { id, kind, name, sort, deleted } = r as Record<string, unknown>;
      if (typeof id !== 'string' || id.length < 1 || id.length > 64) continue;
      if (kind !== 'expense' && kind !== 'income') continue;
      if (typeof name !== 'string' || name.trim() === '') continue;
      if (typeof sort !== 'number' || !Number.isFinite(sort)) continue;
      map.set(id, deleted === true ? null : { id, kind, name, sort });
    }
  }
  const out = [...map.values()].filter((c): c is BotCat => c !== null);
  return out.sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'expense' ? -1 : 1) || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
