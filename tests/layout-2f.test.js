// 2f Task 11 headless 截图发现的版面问题（320 宽大字级等）：用源码锁住修法，实际效果再用 headless 截图确认
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const css = read('../css/app.css');
// 取某个选择器（整行开头完全相同）的规则内容
const rule = (sel) => {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at >= 0, `找不到 ${sel}`);
  return css.slice(at, css.indexOf('}', at));
};

test('① ② 右边内容很长的列：左边标签不缩、不换行（不会被挤成直排）', () => {
  const r = rule('.inset-row.has-long-detail > .inset-row-label');
  assert.match(r, /flex: 1 0 auto;/);
  assert.match(r, /white-space: nowrap;/);
  assert.match(read('../js/ui/settings.js'), /class: 'inset-row has-long-detail'/);
  assert.match(read('../js/ui/invites-page.js'), /rNote\.el\.classList\.add\('has-long-detail'\)/);
});

test('③ 导航列返回字不换行；左栏至少放得下返回字（不和标题黏在一起）', () => {
  assert.match(rule('.nav-back'), /white-space: nowrap;/);
  assert.match(rule('.nav-page-bar'), /grid-template-columns: minmax\(max-content, 1fr\) auto 1fr;/);
});

test('⑤ 大字邀请码保持一行，窄屏自动缩小', () => {
  const r = rule('.invite-big-code');
  assert.match(r, /white-space: nowrap;/);
  assert.match(r, /font: 700 min\(2\.2rem, 13vw\)\/1\.2 /);
});

test('has-long-detail 自足：右边内容可缩、可换行、靠右（复核 A，不靠另外的 class）', () => {
  const r = rule('.inset-row.has-long-detail > .inset-row-detail');
  for (const d of ['flex: 0 1 auto;', 'min-width: 0;', 'overflow-wrap: anywhere;', 'text-align: right;']) assert.ok(r.includes(d), d);
  assert.ok(!css.includes('.inset-row-detail.account-email {'), '旧的重复规则要并掉');
  assert.ok(!css.includes('\n.invite-detail-note {'), '旧的重复规则要并掉');
});
