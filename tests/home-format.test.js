import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceSizeClass, balanceParts, meterText, countText, flowSizeClass,
  HIDE_KEY, MASK, readHidden, writeHidden, cardView, eyeButtonState, floatText, flipEnterable, mergeReason, rowTapAllowed, paintCardEarly, enterTargets, newDayKeys,
} from '../js/ui/home.js';
import { rowIconAttr } from '../js/ui/icons.js';

test('balanceSizeClass：整数部分字元数（含 U+2212 与逗号）≤5 / 6–9 / ≥10', () => {
  assert.equal(balanceSizeClass(123450), '');               // 1,234
  assert.equal(balanceSizeClass(-123450), 'is-long');       // −1,234
  assert.equal(balanceSizeClass(1234567), 'is-long');       // 12,345
  assert.equal(balanceSizeClass(123456700), 'is-long');     // 1,234,567
  assert.equal(balanceSizeClass(999999999900), 'is-xlong'); // 9,999,999,999
});

test('balanceSizeClass 边界', () => {
  assert.equal(balanceSizeClass(0), '');                  // 0
  assert.equal(balanceSizeClass(999999), '');             // 9,999（5）
  assert.equal(balanceSizeClass(-99999), '');             // −999（4）
  assert.equal(balanceSizeClass(1000000), 'is-long');     // 10,000（6）
  assert.equal(balanceSizeClass(-999999), 'is-long');     // −9,999（6）
  assert.equal(balanceSizeClass(999999900), 'is-long');   // 9,999,999（9）
  assert.equal(balanceSizeClass(1000000000), 'is-xlong'); // 10,000,000（10）
  assert.equal(balanceSizeClass(-100000000), 'is-xlong'); // −1,000,000（10）
});

test('meterText：三种状态的逐字文案', () => {
  assert.equal(meterText({ state: 'ratio', pct: 68 }), '已花掉收入的 68%');
  assert.equal(meterText({ state: 'ratio', pct: 0 }), '已花掉收入的 0%');
  assert.equal(meterText({ state: 'over', pct: 100 }), '支出已超过收入');
  assert.equal(meterText({ state: 'none', pct: 0 }), '本月还没有收入');
});

test('countText：共 N 笔', () => {
  assert.equal(countText(0), '共 0 笔');
  assert.equal(countText(230), '共 230 笔');
});

test('flowSizeClass：收入 / 支出金额字串 ≥13 字元缩一级', () => {
  assert.equal(flowSizeClass(9999999), '');          // RM 99,999.99（12）
  assert.equal(flowSizeClass(99999999), 'is-small'); // RM 999,999.99（13）
  assert.equal(flowSizeClass(10002345599), 'is-small');
});

test('balanceParts：sign / 整数 / .角，负数 sign 为 U+2212（显示在 RM 之前）', () => {
  assert.deepEqual(balanceParts(123450), { sign: '', int: '1,234', dec: '.50' });
  assert.deepEqual(balanceParts(-5), { sign: '−', int: '0', dec: '.05' });
  assert.deepEqual(balanceParts(0), { sign: '', int: '0', dec: '.00' });
});

test('rowIconAttr：有效分类 → iconKey；已删除 / 未分类 → null', () => {
  assert.equal(rowIconAttr({ icon: 'food', deleted: false }), 'food');
  assert.equal(rowIconAttr({ icon: 'not-a-real-icon', deleted: false }), 'other');
  assert.equal(rowIconAttr({ icon: 'food', deleted: true }), null);
  assert.equal(rowIconAttr(null), null);
  assert.equal(rowIconAttr(undefined), null);
});

test('CSS：增加对比度 / 降低透明度时拿掉光球与反光边，卡片改不透明，且写在结余卡规则之后', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const marker = '@media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {\n  .home-card-wrap::before';
  const i = css.indexOf(marker);
  assert.ok(i >= 0);
  const block = css.slice(i, css.indexOf('\n}', i));
  assert.match(block, /\.home-card-wrap::before,\s*\.home-card::before\s*\{\s*display:\s*none;/);
  assert.match(block, /\.home-card \{ background: var\(--glass\); border: 1px solid var\(--glass-edge\); \}/);
  assert.ok(i > css.indexOf('\n.home-card {'), '后备规则要在 .home-card 之后才压得过');
});

test('CSS：窄屏缩级写在同优先级的基础规则之后（靠文件顺序压过）', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const narrow = [...css.matchAll(/@media \(max-width: 359px\) \{/g)].map((m) => m.index);
  assert.equal(narrow.length, 2);
  // 基础规则要存在，而且「最后一次出现」也在媒体查询之前（防止以后有人在后面再写一条同名基础规则）
  const after = (rule, i) => assert.ok(css.indexOf(rule) >= 0 && css.lastIndexOf(rule) < i, rule);
  after('\n.home-balance.is-xlong .home-balance-dec {', narrow[0]);   // 顶格＝基础规则（媒体查询里的有缩进）
  after('\n.home-balance-sign {', narrow[0]);
  after('\n.home-balance-cur {', narrow[0]);
  after('\n.home-balance-int {', narrow[0]);
  after('\n.home-balance-dec {', narrow[0]);
  after('\n.home-flow-v.is-small {', narrow[1]);
  after('\n.home-flow-v {', narrow[1]);
  assert.match(css.slice(narrow[0], css.indexOf('\n}', narrow[0])), /\.home-balance\.is-long \.home-balance-int/);
  assert.match(css.slice(narrow[1], css.indexOf('\n}', narrow[1])), /\.home-flow-v \{/);
});

test('CSS：结余卡不用模糊；旧的彩虹光晕与让开逻辑都拿掉', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const gone of ['--halo-', '--glow-dx', 'cqw', '.home-card.is-long']) assert.ok(!css.includes(gone), gone);
  const card = css.slice(css.indexOf('\n.home-card {'), css.indexOf('.home-card-label'));
  assert.ok(!/backdrop-filter|filter:/.test(card));
  assert.match(css, /\.screen\[data-screen="home"\] \{ isolation: isolate; \}/);
  // 包装层不能自己建层叠上下文，否则光球会盖到大标题与「记一笔」上（只检查基础规则，媒体查询里的覆盖不在范围内）
  const wrap = css.slice(css.indexOf('\n.home-card-wrap {'), css.indexOf('\n.home-card-wrap::before'));
  assert.ok(!/isolation|z-index|transform|opacity|filter|contain|will-change|mask|clip-path|mix-blend-mode|perspective/.test(wrap));
  assert.ok(!/position:\s*(fixed|sticky)/.test(wrap));
});

// ---------- 眼睛：隐藏金额 ----------
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}
const throwing = {
  getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); },
};

test('readHidden / writeHidden：存 \'1\'，显示时删掉键；读写失败当作显示、不抛错', () => {
  const st = memStorage();
  assert.equal(readHidden(st), false);
  writeHidden(st, true);
  assert.equal(st.map.get(HIDE_KEY), '1');
  assert.equal(readHidden(st), true);
  writeHidden(st, false);
  assert.equal(st.map.has(HIDE_KEY), false);
  assert.equal(readHidden(memStorage({ [HIDE_KEY]: 'yes' })), false);
  assert.equal(readHidden(null), false);
  assert.equal(readHidden(throwing), false);
  assert.doesNotThrow(() => writeHidden(throwing, true));
  assert.doesNotThrow(() => writeHidden(null, true));
});

test('cardView 显示：与原本格式相同', () => {
  const v = cardView({ balance: -1234567, income: 100000000, expense: 101234567 }, false);
  assert.equal(v.sign, '\u2212');
  assert.equal(v.int, '12,345');
  assert.equal(v.dec, '.67');
  assert.equal(v.sizeCls, 'is-long');
  assert.equal(v.balSr, '\u2212RM 12,345.67');
  assert.deepEqual(v.income, { text: 'RM 1,000,000.00', sr: 'RM 1,000,000.00', cls: 'is-small' });
  assert.equal(v.expense.text, 'RM 1,012,345.67');
});

test('cardView 隐藏：数字、负号、缩级都不留，读屏读「已隐藏」', () => {
  const big = cardView({ balance: -999999999900, income: 100000000, expense: 101234567 }, true);
  const small = cardView({ balance: 500, income: 500, expense: 0 }, true);
  assert.deepEqual(big, small, '金额大小与正负都看不出来');
  assert.equal(big.sign, '');
  assert.equal(big.int, MASK);
  assert.equal(big.dec, '');
  assert.equal(big.sizeCls, '');
  assert.equal(big.balSr, '已隐藏');
  for (const f of [big.income, big.expense]) assert.deepEqual(f, { text: `RM ${MASK}`, sr: '已隐藏', cls: '' });
  const { pct, ...meterRest } = big.meter;   // 线宽固定 0（下面另外检查）
  assert.equal(pct, 0);
  assert.ok(!/\d/.test(JSON.stringify({ ...big, meter: meterRest })), '不能有任何数字');
  // 比例线：没收入 / 超支 / 一般 三种情况隐藏后完全一样（看不出结余正负）
  const none = cardView({ balance: 0, income: 0, expense: 0 }, true);
  const over = cardView({ balance: -500, income: 100, expense: 600 }, true);
  assert.deepEqual(none.meter, big.meter);
  assert.deepEqual(over.meter, big.meter);
  assert.deepEqual(big.meter, { barHidden: false, pct: 0, label: '花费比例已隐藏', note: '已花掉收入的 \u2022\u2022%', noteRead: false });
});

test('cardView 显示：比例线与原本相同（线条读出时文字不重复读）', () => {
  assert.deepEqual(cardView({ balance: 3200, income: 10000, expense: 6800 }, false).meter,
    { barHidden: false, pct: 68, label: '已花掉收入的 68%', note: '已花掉收入的 68%', noteRead: false });
  assert.deepEqual(cardView({ balance: 0, income: 0, expense: 0 }, false).meter,
    { barHidden: true, pct: 0, label: '本月还没有收入', note: '本月还没有收入', noteRead: true });
  assert.equal(cardView({ balance: -500, income: 100, expense: 600 }, false).meter.note, '支出已超过收入');
});

test('eyeButtonState：标签说「按了会怎样」', () => {
  assert.deepEqual(eyeButtonState(false), { label: '隐藏金额', icon: 'eye' });
  assert.deepEqual(eyeButtonState(true), { label: '显示金额', icon: 'eye-off' });
});

test('CSS：大标题列允许换行（大字级时月份换到下一行，不挤压「记账」）', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const i = css.indexOf('.large-title-row {');
  assert.ok(i >= 0);
  assert.match(css.slice(i, css.indexOf('}', i)), /flex-wrap:\s*wrap/);
});

test('floatText：收入 +RM、支出 U+2212 RM', () => {
  assert.equal(floatText({ kind: 'income', amount_minor: 480000 }), '+RM 4,800.00');
  assert.equal(floatText({ kind: 'expense', amount_minor: 3800 }), '\u2212RM 38.00');
});

test('CSS/JS：比例线填充固定 100% 宽、只用 transform 滑入，左侧有延伸补缝', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  const fill = css.slice(css.indexOf('\n.home-meter-fill {'), css.indexOf('}', css.indexOf('\n.home-meter-fill {')));
  assert.match(fill, /width:\s*100%/);
  assert.match(fill, /position:\s*absolute/);
  const ext = css.slice(css.indexOf('\n.home-meter-fill::before {'));
  assert.ok(css.includes('\n.home-meter-fill::before {'), '缺左侧延伸');
  assert.match(ext.slice(0, ext.indexOf('}')), /right:\s*100%/);
  assert.ok(!/meterFill\.style\.width/.test(js), '不能再改 width');
  assert.match(js, /slideX\(/);
});

test('CSS：收入 / 支出滚轮的格高等于原本的行高', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.home-flow-v \.roll \{[^}]*--roll-h:\s*1\.294em/);
});

test('paintCardEarly：没有浮层且有待画变动才先画卡片', () => {
  assert.equal(paintCardEarly({ depth: 0, pendingReason: 'data' }), true);
  assert.equal(paintCardEarly({ depth: 1, pendingReason: 'data' }), false);
  assert.equal(paintCardEarly({ depth: 0, pendingReason: null }), false);
});

test('home.js：卡片可以在浮层关掉时先画，列表只在 whenIdle 里画', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  const i = js.indexOf('onDepthChange(');
  assert.ok(i >= 0, '要监听 onDepthChange');
  const cb = js.slice(i, js.indexOf('\n  });', i));
  assert.match(cb, /paintCardEarly\(/);
  assert.match(cb, /updateCard\(/);
  assert.ok(!/flushRender\(|render\(/.test(cb), 'onDepthChange 里不能画列表');
  const rr = js.slice(js.indexOf('function requestRender('), js.indexOf('function flushRender('));
  assert.match(rr, /!isIdle\(\) && paintCardEarly\(/);
  const iEarly = rr.indexOf('updateCard(');
  assert.ok(iEarly >= 0 && iEarly < rr.indexOf('if (dragging > 0)'), '先画卡片在拖动判断之前');
  assert.match(rr.slice(rr.lastIndexOf('\n', iEarly), iEarly), /try \{/, '先画卡片出错不能挡住列表排队');
  assert.match(rr, /whenIdle\(\(\) => \{[\s\S]*flushRender\(\);/);
  // 隐藏金额：updateCard 用 shouldAnimateCard 决定动不动；只有要动才取飘字
  const uc = js.slice(js.indexOf('function updateCard('), js.indexOf('function paintCard('));
  assert.ok(uc.length > 0, '要有 updateCard（写在 paintCard 前面）');
  assert.match(uc, /shouldAnimateCard\(/);
  // 资料变动就取走飘字标记（隐藏时也取，免得之后误飘旧金额），只有 anim 才真的飘
  assert.match(uc, /const floats = [^\n]*takeFloats\(\)/);
  assert.ok(!/if \(anim\)[^\n]*takeFloats\(\)/.test(uc), '不能只在 anim 时才取');
  assert.match(uc, /if \(anim\)[^\n]*floats/);
  assert.ok(!/takeJustAdded|markJustAdded/.test(js), '旧标记已移除');
});

test('home.js：重画时机只有一个来源（whenIdle），拖动结束也走 requestRender', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  assert.ok(!/depth\(\)\s*>\s*0\)\s*\{\s*\n\s*if \(!idleQueued/.test(js) && !/if \(depth\(\) > 0\) \{\s*\n\s*if \(!idleQueued\)/.test(js), 'requestRender 不能自己判断 depth');
  assert.ok(!/renderPending && dragging === 0\) flushRender\(\)/.test(js), '拖动结束不能直接画');
  assert.match(js, /if \(pendingReason === null\) return;/);
});

test('home.js：切换眼睛时停掉金额动画、移除飘字，但不碰眼睛按钮', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  const body = js.slice(js.indexOf('function setHidden('), js.indexOf('function floatUp('));
  assert.match(body, /\.home-float/);
  assert.ok(!/cancelAnims\(summary, \{ subtree: true \}\)/.test(body), '整张卡一起取消会连眼睛按钮的过渡也取消');
});

test('CSS：飘字在标签那一行（眼睛左边），不压在结余数字上', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const f = css.slice(css.indexOf('\n.home-card > .home-float {'));
  const body = f.slice(0, f.indexOf('}'));
  assert.match(body, /top:\s*22px/);
  assert.match(body, /right:\s*60px/);
});

test('flipEnterable：只有「资料变动」的新列会滑入；显示更多、从背景回来、首次不会', () => {
  assert.equal(flipEnterable('data', false), true);
  assert.equal(flipEnterable('more', false), false);
  assert.equal(flipEnterable('wake', false), false);
  assert.equal(flipEnterable('data', true), false);
});

test('home.js：列与日期区块带 data-flip，render 前后量位置；左滑删除先滑出才删', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  assert.match(js, /'data-flip': `t\$\{tx\.id\}`/);
  assert.match(js, /'data-flip': `d\$\{g\.date\}`/);
  assert.match(js, /snapshotTops\(list\)/);
  assert.match(js, /playFlip\(list,/);
  const del = js.slice(js.indexOf('function deleteRow('), js.indexOf('function attachSwipe('));
  assert.ok(del.indexOf('slideOut') >= 0 && del.indexOf('store.deleteTransaction') >= 0);
  assert.ok(del.indexOf('slideOut') < del.indexOf('store.deleteTransaction'), '要先滑出再删除');
  assert.match(del, /if \(rec\.deleting\) return;/);
  assert.match(del, /cancelAnims\(rec\.el, \{ id: 'row-out' \}\)/);
  // 删除成功就把旧 rec 从 rows 拿掉：之后撤销一定建新节点（旧节点停在透明）
  assert.match(del, /if \(rows\.get\(id\) === rec\) rows\.delete\(id\);/);
  const render = js.slice(js.indexOf('function render('), js.indexOf('function setOffset('));
  assert.ok(render.indexOf('snapshotTops(list)') < render.indexOf('list.replaceChildren(...frag)'));
  assert.ok(render.indexOf('window.scrollTo(0, scrollY)') < render.indexOf('playFlip(list,'));
  // 只有这次新出现的列（或新的日期区块）才滑入
  assert.match(render, /addedKeys\.has\(key\)/);
});

test('home.js：滑出中的列不能再打开编辑；首页隐藏时不做 FLIP；滑出有保险计时', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  const click = js.slice(js.indexOf('function onRowClick('), js.indexOf('function onRowClick(') + 300);
  assert.match(click, /if \(rec\.deleting\) return;/);
  assert.match(js, /list\.closest\('\[hidden\]'\)/);
  const out = js.slice(js.indexOf('function slideOut('), js.indexOf('function deleteRow('));
  assert.match(out, /setTimeout\(/);
});

test('mergeReason：多次变动合并，data 优先', () => {
  assert.equal(mergeReason(null, 'wake'), 'wake');
  assert.equal(mergeReason('wake', 'data'), 'data');
  assert.equal(mergeReason('data', 'more'), 'data');
  assert.equal(mergeReason('more', 'wake'), 'more');
});

test('rowTapAllowed：有还没画上去的变动时，不能点列（会拿到旧资料）', () => {
  assert.equal(rowTapAllowed(null), true);
  assert.equal(rowTapAllowed('data'), false);
  assert.equal(rowTapAllowed('wake'), false);
});

test('enterTargets 新区块只动区块', () => {
  assert.deepEqual(enterTargets([
    { rowKey: 't1', dayKey: 'd2026-11-22' }, { rowKey: 't2', dayKey: 'd2026-11-22' },
  ], new Set(['d2026-11-22'])), ['d2026-11-22']);
});

test('enterTargets 旧区块动列', () => {
  assert.deepEqual(enterTargets([{ rowKey: 't1', dayKey: 'd2026-11-20' }], new Set()), ['t1']);
  assert.deepEqual(enterTargets([], new Set(['d2026-11-20'])), []);
});

test('home.js：本机刚存 → 不量位置、不补位，只让新的一笔进场；标记一律在提前 return 之前取走', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  const render = js.slice(js.indexOf('function render('), js.indexOf('function setOffset('));
  const iTake = render.indexOf('const local = takeSavedForList();');
  const iEmpty = render.indexOf('if (all.length === 0)');
  assert.ok(iTake >= 0 && iEmpty > iTake, 'takeSavedForList 在空列表提前 return 之前');
  assert.ok(!/\bif \(/.test(render.slice(0, iTake)), 'takeSavedForList 之前没有任何 if（无条件）');
  assert.match(render, /const before = !local\.size && flipEnterable\(reason, first\)/);
  const iBranch = render.indexOf('} else if (local.size');
  assert.ok(iBranch >= 0, '本机刚存的进场分支');
  const branch = render.slice(iBranch);
  assert.match(branch, /^\} else if \(local\.size && flipEnterable\(reason, first\) && !list\.closest\('\[hidden\]'\)\)/, '首页不在画面上不播');
  assert.match(branch, /enterTargets\(/);
  assert.match(branch, /playEnter\(/, '进场用共用的 playEnter（含减弱动态、取消旧动画）');
  assert.ok(!/querySelector\(/.test(branch), '不用 id 拼选择器');
  // 新区块：和上一次画出的日期比；每次 render 都更新（不在本机刚存的分支里），空列表时重设
  const iNew = render.indexOf('newDayKeys(days, lastDays)');
  const iSet = render.indexOf('lastDays = days;');
  assert.ok(iNew >= 0 && iSet > iNew && iSet < iBranch, '先算新区块再更新 lastDays，且在分支之外');
  assert.ok(render.slice(iEmpty, render.indexOf('return;', iEmpty)).includes('lastDays = new Set()'), '空列表时重设');
});

test('home.js：点到旧列先补画，再确认还是同一列', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../js/ui/home.js', import.meta.url), 'utf8');
  for (const name of ['function onRowClick(', 'function deleteRow(']) {
    const i = js.indexOf(name);
    assert.ok(i >= 0, name);
    const body = js.slice(i, js.indexOf('\n  }\n', i));
    const iFlush = body.indexOf('flushRender()');
    assert.ok(iFlush >= 0, `${name} 要先补画`);
    const iTap = body.indexOf('rowTapAllowed(');
    const iDel = body.indexOf('if (rec.deleting) return;');
    assert.ok(iTap > iFlush, `${name}：补画要在 rowTapAllowed 之前（否则补画永远跑不到）`);
    assert.ok(iDel >= 0 && iDel < iFlush, `${name}：删除中先挡掉`);
    assert.match(body.slice(0, iFlush), /pendingReason !== null && dragging === 0/);
    assert.match(body.slice(iFlush), /rows\.get\(rec\.id\) !== rec\) return/);
  }
  const click = js.slice(js.indexOf('function onRowClick('), js.indexOf('function slideOut('));
  assert.ok(!/await/.test(click), 'openEntrySheet 必须同步呼叫');
});

test('newDayKeys：这次有、上一次没有的日期区块', () => {
  assert.deepEqual([...newDayKeys(new Set(['d1', 'd2']), new Set(['d2']))], ['d1']);
  assert.equal(newDayKeys(new Set(['d1']), new Set(['d1'])).size, 0);
  assert.deepEqual([...newDayKeys(new Set(['d1']), new Set())], ['d1']);
});
