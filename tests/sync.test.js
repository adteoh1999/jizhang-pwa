// 2e 同步引擎（js/sync.js）。任务 4：认领本地账本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimState, claim, ensureClaimed } from '../js/sync.js';
import { createStore } from '../js/store.js';
import { createMemoryDb } from './helpers/memory-db.js';
import { saveSession } from '../js/auth.js';

const ME = { user_id: 'u-1', access_token: 'a', refresh_token: 'r', expires_at: 0, email: 'me@x.com' };
const fakeUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function setup({ db = createMemoryDb(), txCount = 0 } = {}) {
  let n = 0;
  let t = Date.parse('2026-11-25T10:00:00Z');
  const store = createStore({ db, now: () => new Date((t += 1000)), uuid: () => fakeUuid(++n) });
  await store.init();
  await saveSession(store, ME);
  for (let i = 0; i < txCount; i++) {
    await store.saveTransaction({ kind: 'expense', amountMinor: 100 + i, categoryId: 'food', occurredOn: '2026-11-20', note: '' });
  }
  return { db, store };
}

test('claimState：没有 owner → unclaimed；相同 → mine；不同 → other', async () => {
  const { store } = await setup();
  assert.equal(await claimState(store, ME), 'unclaimed');
  await store.setMeta('owner_user_id', 'u-1');
  assert.equal(await claimState(store, ME), 'mine');
  await store.setMeta('owner_user_id', 'u-2');
  assert.equal(await claimState(store, ME), 'other');
});

test('claim：owner 写好、全部列 dirty 1（同一次写入）', async () => {
  const { db, store } = await setup({ txCount: 2 });
  await store.markUploaded('transactions', await store.pendingRows('transactions'), []);
  const before = db.calls.length;
  await claim(store, ME);
  assert.equal(db.calls.length - before, 1);
  assert.equal(await store.getMeta('owner_user_id'), 'u-1');
  assert.ok((await db.getAll('transactions')).every((r) => r.dirty === 1));
  assert.ok((await db.getAll('categories')).every((r) => r.dirty === 1));
});

test('claim 写入失败 → owner 没写', async () => {
  const { db, store } = await setup({ txCount: 1 });
  db.failNextWrite(new Error('disk'));
  await assert.rejects(claim(store, ME));
  assert.equal(await store.getMeta('owner_user_id'), undefined);
});

test('ensureClaimed：没有账（只有默认分类）→ 直接认领、不问', async () => {
  const { store } = await setup();
  let asked = 0;
  assert.equal(await ensureClaimed(store, ME, { ask: async () => { asked++; return 'start'; } }), 'mine');
  assert.equal(asked, 0);
  assert.equal(await store.getMeta('owner_user_id'), 'u-1');
});

test('ensureClaimed：有账 → 问一次（传入 N 只数账目）；按开始 → 认领', async () => {
  const { store } = await setup({ txCount: 3 });
  const seen = [];
  assert.equal(await ensureClaimed(store, ME, { ask: async (n) => { seen.push(n); return 'start'; } }), 'mine');
  assert.deepEqual(seen, [3]);
  assert.equal(store.syncCounts().txPending, 3);
});

test('ensureClaimed：关掉提醒 → unclaimed、记下来；下次启动不再自动问，从设置页按「开始」才问', async () => {
  const { store } = await setup({ txCount: 1 });
  let asked = 0;
  const ask = async () => { asked++; return 'dismiss'; };
  assert.equal(await ensureClaimed(store, ME, { ask }), 'unclaimed');
  assert.equal(await store.getMeta('owner_user_id'), undefined);
  assert.equal(await ensureClaimed(store, ME, { ask }), 'unclaimed');
  assert.equal(asked, 1);
  assert.equal(await ensureClaimed(store, ME, { ask: async () => 'start', fromUser: true }), 'mine');
});

test('ensureClaimed：关掉记录是别的账号的 → 这个账号照样会问', async () => {
  const { store } = await setup({ txCount: 1 });
  await store.setMeta('syncPromptDismissed', 'u-OTHER');
  let asked = 0;
  await ensureClaimed(store, ME, { ask: async () => { asked++; return 'dismiss'; } });
  assert.equal(asked, 1);
});

test('ensureClaimed：mine / other 直接回，不问、不写', async () => {
  for (const [owner, expect] of [['u-1', 'mine'], ['u-2', 'other']]) {
    const { db, store } = await setup({ txCount: 1 });
    await store.setMeta('owner_user_id', owner);
    const before = db.calls.length;
    let asked = 0;
    assert.equal(await ensureClaimed(store, ME, { ask: async () => { asked++; return 'start'; } }), expect);
    assert.equal(asked, 0);
    assert.equal(db.calls.length, before);
  }
});

test('ensureClaimed：问的时候别处已认领（另一个分页）→ 不重复认领、回目前状态', async () => {
  const { store } = await setup({ txCount: 1 });
  const r = await ensureClaimed(store, ME, { ask: async () => { await store.setMeta('owner_user_id', 'u-2'); return 'start'; } });
  assert.equal(r, 'other');
  assert.equal(await store.getMeta('owner_user_id'), 'u-2');
});

test('提醒文字：N 笔、按钮是具体动词；换账号对话框不再说新账号会看到', async () => {
  const { SYNC_PROMPT_TEXT: T } = await import('../js/ui/sync-prompt.js');
  assert.equal(T.title, '上传这台设备的账本？');
  assert.equal(T.message(3), '这台设备的 3 笔账会上传到你的账号。建议先导出 CSV 备份。');
  assert.equal(T.laterLabel, '以后再说');
  assert.equal(T.exportLabel, '导出 CSV');
  assert.equal(T.startLabel, '开始同步');
  const { readFileSync } = await import('node:fs');
  const login = readFileSync(new URL('../js/ui/login.js', import.meta.url), 'utf8');
  assert.doesNotMatch(login, /新账号会看到/);
});

test('导出抽到 export-csv.js：设置页与提醒共用，share 在点击里同步呼叫', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../js/ui/settings.js'), /createExporter\(store\)/);
  assert.match(read('../js/ui/sync-prompt.js'), /createExporter\(store\)/);
  const ex = read('../js/ui/export-csv.js');
  const body = ex.slice(ex.indexOf('return function exportCsv'));
  assert.ok(body.indexOf('nav.share(') > 0); // 3c-2：navigator 改成可注入的 nav（预设就是 navigator）
  assert.doesNotMatch(body.slice(0, body.indexOf('nav.share(')), /await /);
  assert.match(ex, /nav = globalThis\.navigator/);
});

test('ensureClaimed：claim 失败 → reject，owner 与 dismissed 都没写，下次照样问', async () => {
  const { db, store } = await setup({ txCount: 1 });
  let asked = 0;
  const ask = async () => { asked++; db.failNextWrite(new Error('disk')); return 'start'; };
  await assert.rejects(ensureClaimed(store, ME, { ask }));
  assert.equal(await store.getMeta('owner_user_id'), undefined);
  assert.equal(await store.getMeta('syncPromptDismissed'), undefined);
  await ensureClaimed(store, ME, { ask: async () => { asked++; return 'start'; } });
  assert.equal(asked, 2);
});

test('ensureClaimed：ask 期间别处认领成同一账号 → mine、不再写；回 dismiss 但别处已认领 → 不写 dismissed', async () => {
  let { db, store } = await setup({ txCount: 1 });
  let before;
  assert.equal(await ensureClaimed(store, ME, { ask: async () => { await store.setMeta('owner_user_id', 'u-1'); before = db.calls.length; return 'start'; } }), 'mine');
  assert.equal(db.calls.length, before);
  ({ store } = await setup({ txCount: 1 }));
  assert.equal(await ensureClaimed(store, ME, { ask: async () => { await store.setMeta('owner_user_id', 'u-1'); return 'dismiss'; } }), 'mine');
  assert.equal(await store.getMeta('syncPromptDismissed'), undefined);
});

test('ensureClaimed：fromUser 且 dismiss → 有记下', async () => {
  const { store } = await setup({ txCount: 1 });
  assert.equal(await ensureClaimed(store, ME, { ask: async () => 'dismiss', fromUser: true }), 'unclaimed');
  assert.equal(await store.getMeta('syncPromptDismissed'), 'u-1');
});

test('ensureClaimed：问的时候登出了或换了账号 → 不认领', async () => {
  for (const after of [null, { ...ME, user_id: 'u-9' }]) {
    const { store } = await setup({ txCount: 1 });
    const r = await ensureClaimed(store, ME, { ask: async () => { await store.setMeta('session', after); return 'start'; } });
    assert.equal(r, 'unclaimed');
    assert.equal(await store.getMeta('owner_user_id'), undefined);
  }
});

test('ensureClaimed：ask 期间别的分页登出清掉账本、又用同一账号登录 → 不把 dismissed 写进新账本（Task 10 前）', async () => {
  const { db, store } = await setup({ txCount: 1 });
  let n = 100;
  const other = createStore({ db, uuid: () => fakeUuid(++n) });
  await other.init();
  const ask = async () => {
    await other.wipeLocal(); // 另一个分页登出：清空账本、换新 ledgerId
    await saveSession(other, ME); // 之后同一账号又登录（还没认领）
    return 'dismiss';
  };
  assert.equal(await ensureClaimed(store, ME, { ask }), 'unclaimed');
  assert.equal(await store.getMeta('syncPromptDismissed'), undefined);
});

test('owner:null 只给 setMeta 用：applyRemote／markUploaded／markMissingForUpload 遇到 null 一律不写（2f 整体审核小事）', async () => {
  const { db, store } = await setup({ txCount: 1 });
  const row = { id: '00000000-0000-4000-8000-000000000999', kind: 'expense', amount_minor: 100, category_id: 'food', occurred_on: '2026-11-20', note: '', deleted: false, updated_at: '2026-11-25T10:00:00.000Z' };
  assert.equal(await store.applyRemote('transactions', [row], { owner: null }), null);
  assert.equal((await db.getAll('transactions')).length, 1);
  const pending = await store.pendingRows('transactions');
  assert.equal(await store.markUploaded('transactions', pending, [], { owner: null }), null);
  assert.equal((await db.getAll('transactions'))[0].dirty, 1);
  assert.equal(await store.markMissingForUpload('transactions', [], { owner: null }), null);
});
