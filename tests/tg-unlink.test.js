// 3b-10：PWA 设置页「解除 Telegram 连接」（js/ui/tg-unlink.js runTgUnlinkPwa）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runTgUnlinkPwa, TG_UNLINK_TEXT as U } from '../js/ui/tg-unlink.js';

const S = { access_token: 'tok-A', user_id: 'u-A' };
function mk({ confirm = true, online = true, got = { session: S }, unlinks = [{ ok: true, data: { ok: true, unlinked: true, others: true } }], choices = [] } = {}) {
  const log = [];
  let n = 0;
  const ch = [...choices];
  return {
    log,
    deps: {
      userId: 'u-A', isOnline: () => online,
      getSession: async () => got,
      tgLink: async (token, action) => { log.push(`unlink:${token}:${action}`); return unlinks[Math.min(n++, unlinks.length - 1)]; },
      refreshStatus: async () => { log.push('refresh'); },
      toast: (m) => log.push(`toast:${m}`),
      block: (t) => { log.push(`block:${t}`); return () => log.push('unblock'); },
      dialogs: {
        confirmDialog: async (o) => { log.push(`confirm:${o.title}`); log.confirm = o; return confirm; },
        choiceDialog: async (o) => { log.push(`choice:${o.title}`); log.choice = o; return ch.length ? ch.shift() : 'later'; },
        messageDialog: async (o) => { log.push(`message:${o.title}`); },
      },
    },
  };
}

test('确认框文字（红字「解除连接」）；取消 → 不叫服务器', async () => {
  const { deps, log } = mk({ confirm: false });
  assert.equal(await runTgUnlinkPwa(deps), 'cancel');
  assert.equal(log.confirm.title, '解除 Telegram 连接？');
  assert.equal(log.confirm.message, 'Telegram 里的记账会被登出。这个账号在其他设备（包括别的手机的 PWA）也会被登出，最晚 1 小时内生效。这台设备不受影响。');
  assert.equal(log.confirm.confirmLabel, '解除连接');
  assert.equal(log.confirm.destructive, true);
  assert.ok(!log.some((l) => l.startsWith('unlink')));
});

test('离线 → 「需要网络才能解除连接」，不叫服务器', async () => {
  const { deps, log } = mk({ online: false });
  assert.equal(await runTgUnlinkPwa(deps), 'fail');
  assert.ok(log.includes('message:需要网络才能解除连接'));
  assert.ok(!log.some((l) => l.startsWith('unlink')));
});

test('成功（others:true）→ 遮罩、unlink、刷新状态、toast「已解除连接」', async () => {
  const { deps, log } = mk();
  assert.equal(await runTgUnlinkPwa(deps), 'done');
  assert.deepEqual(log.slice(1), [`block:${U.busy}`, 'unlink:tok-A:unlink', 'unblock', 'refresh', 'toast:已解除连接']);
});

test('others:false → 「已解除连接，但没能登出其他设备」＋「再试一次」会再叫一次 unlink；「稍后」就结束', async () => {
  const half = { ok: true, data: { ok: true, unlinked: true, others: false } };
  const full = { ok: true, data: { ok: true, unlinked: false, others: true } };
  const a = mk({ unlinks: [half, full], choices: ['retry'] });
  assert.equal(await runTgUnlinkPwa(a.deps), 'done');
  assert.equal(a.log.filter((l) => l.startsWith('unlink:')).length, 2);
  assert.equal(a.log.choice.title, '已解除连接，但没能登出其他设备');
  assert.deepEqual(a.log.choice.buttons.map((b) => b.label), ['再试一次', '稍后']);
  const b = mk({ unlinks: [half], choices: ['later'] });
  assert.equal(await runTgUnlinkPwa(b.deps), 'partial');
  assert.equal(b.log.filter((l) => l.startsWith('unlink:')).length, 1);
  assert.ok(b.log.includes('refresh'));
});

test('服务器失败 → messageDialog 显示服务器句子、不 toast', async () => {
  const { deps, log } = mk({ unlinks: [{ ok: false, status: 500, code: null, error: '暂时无法连接，请稍后再试', retry: true }] });
  assert.equal(await runTgUnlinkPwa(deps), 'fail');
  assert.ok(log.includes(`message:${U.pwaFailTitle}`));
  assert.ok(log.includes('unblock'));
  assert.ok(!log.some((l) => l.startsWith('toast')));
});

test('拿不到有效 session、或是别的账号 → 请重新登录，不叫 unlink', async () => {
  for (const got of [{ invalid: true }, { retry: true }, { session: { access_token: 'x', user_id: 'u-B' } }]) {
    const { deps, log } = mk({ got });
    assert.equal(await runTgUnlinkPwa(deps), 'fail');
    assert.ok(!log.some((l) => l.startsWith('unlink')), JSON.stringify(got));
  }
});

test('tg-unlink.js、settings.js 不用 innerHTML（Telegram 名字一律当文字）', () => {
  for (const f of ['../js/ui/tg-unlink.js', '../js/ui/settings.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/, f);
  }
});
