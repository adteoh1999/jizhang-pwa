// 3f：说明页（隐私说明、在 Telegram 记账）与设置页接线（用户 2026-11-28 定稿文案）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INFO_PAGES } from '../js/ui/info-page.js';
import { FOCUSABLE } from '../js/ui/dialogs.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('隐私说明：标题与 5 段逐字', () => {
  assert.equal(INFO_PAGES.privacy.title, '隐私说明');
  assert.deepEqual([...INFO_PAGES.privacy.paras], [
    '账先存在手机里，登录后会同步，换手机或在 Telegram 打开都是同一本账。',
    '管理的人在后台看得到你的账和邮箱。',
    '用 bot 记账时，截图和文字会交给 AI 服务商认金额和分类，一般最多留 30 天，我们不存截图。App 里手动记的不会。',
    '不想用了，在设置最下面删账号，服务器上的账会全部删掉。删之前可以先导出 CSV。',
    '有问题直接问邀请你的人。',
  ]);
});

test('在 Telegram 记账：开头、3 步、2 句提醒、按钮（t.me 链接）逐字', () => {
  const t = INFO_PAGES.telegram;
  assert.equal(t.title, '在 Telegram 记账');
  assert.equal(t.lead, '在 Telegram 传付款截图，或打「午餐 12.50」，就会记一笔，跟这里是同一本账。');
  assert.deepEqual([...t.steps], [
    '打开 @adjizhangbot，按「开始」。',
    '按左下角「记账」，用同一个邮箱登录。',
    '问你要不要连接时，按「连接」。',
  ]);
  assert.deepEqual([...t.notes], [
    '在 Telegram 登录要 10 分钟内弄完，先把收信的 App 开着比较快。',
    '画面出错就关掉再开一次。',
  ]);
  assert.deepEqual({ ...t.action }, { label: '打开 @adjizhangbot', href: 'https://t.me/adjizhangbot' });
});

test('文案规则：不提 Claude／Anthropic、不用「站主」', () => {
  const all = JSON.stringify(INFO_PAGES);
  for (const bad of ['Claude', 'Anthropic', '站主']) assert.ok(!all.includes(bad), bad);
});

test('info-page.js：文字一律 textContent（不用 innerHTML）、步骤用 <ol>、链接是真的 <a>（新分页、noopener）', () => {
  const src = read('../js/ui/info-page.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML/);
  assert.match(src, /h\('ol'/);
  assert.match(src, /h\('a', \{[^}]*href: page\.action\.href[^}]*target: '_blank'[^}]*rel: 'noopener noreferrer'/); // 最终审核：不带来源网址
  assert.match(src, /trapFocus\(/);
  assert.match(src, /pushLayer\(/);
});

test('浮层的 Tab 循环包含链接（a[href]），说明页的按钮用键盘也按得到', () => {
  assert.ok(FOCUSABLE.split(',').map((s) => s.trim()).includes('a[href]'), FOCUSABLE);
});

test('设置页接线：tg-help 按钮只建一次、在登出兜底之前；关于区有「隐私说明」；兜底改成明确判断 signout', () => {
  const src = read('../js/ui/settings.js');
  const help = src.indexOf("const tgHelpBtn = ");
  const section = src.indexOf('const accountSection = () => {');
  assert.ok(help >= 0 && section > help, 'tgHelpBtn 在 accountSection 之前建立（重建账号区时重复使用）');
  const end = src.indexOf('\n  };\n', section);
  assert.ok(end > section);
  const body = src.slice(section, end);
  const helpBranch = body.indexOf("if (r.kind === 'tg-help') return tgHelpBtn;");
  const signout = body.indexOf("if (r.kind === 'signout')");
  assert.ok(helpBranch >= 0 && signout > helpBranch, 'tg-help 分支在 signout 之前');
  assert.match(src, /openInfoPage\('telegram'\)/);
  assert.match(src, /buttonRow\('隐私说明', \(\) => openInfoPage\('privacy'\), \{ chevron: true \}\)/);
});

test('说明页样式：段落在白卡片里；「打开 @adjizhangbot」是这页唯一的深绿主按钮（≥44px、白字）', async () => {
  const { css } = await import('./helpers/css-tokens.js');
  assert.match(css, /\.info-card \{[^}]*background: var\(--bg-grouped-secondary\);/);
  const rule = css.match(/\.info-action \{([^}]*)\}/);
  assert.ok(rule, '有 .info-action');
  assert.match(rule[1], /background: var\(--btn-bg\);/);
  assert.match(rule[1], /color: var\(--btn-fg\);/);
  const mh = rule[1].match(/min-height: (\d+)px;/);
  assert.ok(mh && Number(mh[1]) >= 44, '按钮至少 44px 高');
  assert.match(rule[1], /text-decoration: none;/);
});

test('3f 最终审核：步骤与按钮的长字（@adjizhangbot）在超大字级可断行', async () => {
  const { css } = await import('./helpers/css-tokens.js');
  assert.match(css, /\.info-steps \{[^}]*overflow-wrap: anywhere;/);
  assert.match(css.match(/\.info-action \{([^}]*)\}/)[1], /overflow-wrap: anywhere;/);
});
