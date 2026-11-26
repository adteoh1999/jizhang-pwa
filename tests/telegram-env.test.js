// 3b-6：index.html 内嵌脚本（有 Telegram 桥接才载 SDK）、js/telegram.js 平台判断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectTelegram, initDataLeft, closeMiniApp, TG_SDK_URL, TG_SDK_TIMEOUT_MS, TG_BRIDGE_WAIT_MS } from '../js/telegram.js';
import { TG_LOGIN_URL, TG_LINK_URL, TG_ADMIN_URL, SUPABASE_URL } from '../js/config.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const SDK = 'https://telegram.org/js/telegram-web-app.js?65';

// ---------------- 假浏览器 ----------------

function fakeStorage({ throws = false } = {}) {
  const m = new Map();
  const bad = () => { throw new Error('SecurityError'); };
  return {
    map: m,
    getItem: throws ? bad : (k) => (m.has(k) ? m.get(k) : null),
    setItem: throws ? bad : (k, v) => { m.set(k, String(v)); },
    removeItem: throws ? bad : (k) => { m.delete(k); },
  };
}

// sdk：插入 SDK 脚本后怎么回应：'webapp'（onload＋有 WebApp）、'empty'（onload 但没 WebApp）、'error'、'never'
function fakeWin({ hash = '', bridge = false, sdk = 'webapp', webApp = null, storageThrows = false } = {}) {
  const scripts = [];
  const replaced = [];
  const win = {
    location: { hash, pathname: '/', search: '' },
    sessionStorage: fakeStorage({ throws: storageThrows }),
    history: { replaceState: (s, t, url) => { replaced.push(url); win.location.hash = ''; } },
    document: null,
    scripts, replaced,
  };
  if (bridge) win.TelegramWebviewProxy = { postEvent() {} };
  win.document = {
    createElement: (tag) => ({ tag, src: '', onload: null, onerror: null }),
    head: {
      appendChild: (el) => {
        scripts.push(el);
        setTimeout(() => {
          if (sdk === 'webapp') { win.Telegram = { WebApp: webApp ?? makeWebApp() }; el.onload?.(); }
          else if (sdk === 'empty') el.onload?.();
          else if (sdk === 'error') el.onerror?.();
        }, 5);
      },
    },
  };
  return win;
}

function makeWebApp({ initData = 'query_id=x&user=%7B%7D&auth_date=1764000000&hash=ab', user = { id: 987654321 }, authDate = '1764000000', platform = 'ios', version = '8.0' } = {}) {
  const calls = [];
  return {
    initData,
    initDataUnsafe: { user, auth_date: authDate },
    platform, version,
    ready: () => calls.push('ready'),
    expand: () => calls.push('expand'),
    close: () => calls.push('close'),
    calls,
  };
}

// ---------------- 内嵌脚本 ----------------

function inlineScript() {
  const m = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(m.length, 1, 'index.html 应该刚好有一段内嵌脚本');
  return m[0][1];
}

function runInline(win) {
  const ctx = vm.createContext({ window: win, setTimeout, Promise });
  vm.runInContext(inlineScript(), ctx);
  return win;
}

test('index.html：内嵌脚本在 module 脚本之前', () => {
  const iInline = html.search(/<script(?![^>]*\bsrc=)[^>]*>/);
  const iModule = html.indexOf('<script type="module"');
  assert.ok(iInline > 0 && iModule > 0 && iInline < iModule);
});

test('index.html：内嵌脚本是 ES5（没有 =>、let、const、class、模板字串），整段包在 try 里', () => {
  const s = inlineScript();
  assert.doesNotMatch(s, /=>|\blet\b|\bconst\b|\bclass\b|`/);
  assert.match(s, /try\s*\{/);
  assert.doesNotMatch(s, /console\./);
});

test('内嵌脚本：没有桥接（不管有没有 hash）→ 不插任何脚本、没有 __tgSdk', () => {
  for (const hash of ['', '#tgWebAppData=abc&tgWebAppVersion=8.0']) {
    const w = runInline(fakeWin({ hash }));
    assert.equal(w.scripts.length, 0, hash);
    assert.equal(w.__tgSdk, undefined);
  }
});

test('内嵌脚本：hash 有 tgWebAppData= → 写 sessionStorage jz_tg=1；没有就不写', () => {
  const a = runInline(fakeWin({ hash: '#tgWebAppData=abc' }));
  assert.equal(a.sessionStorage.map.get('jz_tg'), '1');
  const b = runInline(fakeWin({ hash: '#other=1' }));
  assert.equal(b.sessionStorage.map.has('jz_tg'), false);
});

test('内嵌脚本：有桥接 → 插入 SDK（网址精确）；onload 有 WebApp → __tgSdk 为 true', async () => {
  const w = runInline(fakeWin({ bridge: true }));
  assert.equal(w.scripts.length, 1);
  assert.equal(w.scripts[0].tag, 'script');
  assert.equal(w.scripts[0].src, SDK);
  assert.equal(await w.__tgSdk, true);
});

test('内嵌脚本：有桥接、onload 但没有 Telegram.WebApp → false；onerror → false', async () => {
  assert.equal(await runInline(fakeWin({ bridge: true, sdk: 'empty' })).__tgSdk, false);
  assert.equal(await runInline(fakeWin({ bridge: true, sdk: 'error' })).__tgSdk, false);
});

test('内嵌脚本：sessionStorage 丢错也不会当掉，照样载 SDK', async () => {
  const w = fakeWin({ hash: '#tgWebAppData=abc', bridge: true, storageThrows: true });
  assert.doesNotThrow(() => runInline(w));
  assert.equal(w.scripts.length, 1);
  assert.equal(await w.__tgSdk, true);
});

test('内嵌脚本：document 坏掉也不会丢错', () => {
  const w = fakeWin({ bridge: true });
  w.document = null;
  assert.doesNotThrow(() => runInline(w));
});

// ---------------- config ----------------

test('config：三个 Telegram 函数网址', () => {
  assert.equal(TG_LOGIN_URL, `${SUPABASE_URL}/functions/v1/tg-login`);
  assert.equal(TG_LINK_URL, `${SUPABASE_URL}/functions/v1/tg-link`);
  assert.equal(TG_ADMIN_URL, `${SUPABASE_URL}/functions/v1/tg-admin`);
});

test('telegram.js：常数', () => {
  assert.equal(TG_SDK_URL, SDK);
  assert.equal(TG_SDK_TIMEOUT_MS, 8000);
  assert.equal(TG_BRIDGE_WAIT_MS, 1500);
});

// ---------------- detectTelegram ----------------

test('detectTelegram：没有桥接、没有 hint → pwa，马上回（不等桥接）、不插脚本', async () => {
  const w = fakeWin();
  const t0 = Date.now();
  assert.deepEqual(await detectTelegram({ win: w }), { mode: 'pwa' });
  assert.ok(Date.now() - t0 < 50);
  assert.equal(w.scripts.length, 0);
  assert.deepEqual(w.replaced, []);
});

test('detectTelegram：没有桥接但有 hash → 等到 bridgeWaitMs 还是没有 → pwa，这时才清 hash、删 jz_tg', async () => {
  const w = fakeWin({ hash: '#tgWebAppData=abc' });
  w.sessionStorage.setItem('jz_tg', '1');
  const t0 = Date.now();
  const r = await detectTelegram({ win: w, bridgeWaitMs: 250 });
  assert.deepEqual(r, { mode: 'pwa' });
  assert.ok(Date.now() - t0 >= 200, '要等一下');
  assert.deepEqual(w.replaced, ['/']);
  assert.equal(w.location.hash, '');
  assert.equal(w.sessionStorage.map.has('jz_tg'), false);
  assert.equal(w.scripts.length, 0, '没桥接绝不载 SDK');
});

test('detectTelegram：只有 jz_tg（重新整理后 hash 没了）也会等桥接', async () => {
  const w = fakeWin();
  w.sessionStorage.setItem('jz_tg', '1');
  setTimeout(() => { w.TelegramWebviewProxy = {}; }, 150);
  const r = await detectTelegram({ win: w, bridgeWaitMs: 1000 });
  assert.equal(r.mode, 'telegram');
});

test('detectTelegram：清 hash 时保留路径与查询字串', async () => {
  const w = fakeWin({ hash: '#tgWebAppData=abc' });
  w.location.pathname = '/app/';
  w.location.search = '?x=1';
  await detectTelegram({ win: w, bridgeWaitMs: 50 });
  assert.deepEqual(w.replaced, ['/app/?x=1']);
});

test('detectTelegram：桥接晚 200 毫秒才出现 → telegram（没有 __tgSdk 就自己补载 SDK）', async () => {
  const w = fakeWin({ hash: '#tgWebAppData=abc' });
  setTimeout(() => { w.TelegramWebviewProxy = {}; }, 200);
  const r = await detectTelegram({ win: w, bridgeWaitMs: 1500 });
  assert.equal(r.mode, 'telegram');
  assert.equal(w.scripts.length, 1);
  assert.equal(w.scripts[0].src, SDK);
  assert.deepEqual(w.replaced, [], 'telegram 模式不清 hash');
});

test('detectTelegram：有桥接、有 __tgSdk → 等它，不再插第二个脚本；回传栏位精确，叫了 ready、expand', async () => {
  const wa = makeWebApp();
  const w = fakeWin({ bridge: true, webApp: wa });
  runInline(w);
  const r = await detectTelegram({ win: w });
  assert.equal(w.scripts.length, 1);
  assert.deepEqual(Object.keys(r).sort(), ['authDate', 'initData', 'mode', 'platform', 'tgId', 'version', 'webApp']);
  assert.equal(r.mode, 'telegram');
  assert.equal(r.webApp, wa);
  assert.equal(r.initData, wa.initData);
  assert.equal(r.tgId, '987654321');
  assert.equal(r.authDate, 1764000000);
  assert.equal(r.platform, 'ios');
  assert.equal(r.version, '8.0');
  assert.deepEqual(wa.calls, ['ready', 'expand']);
});

test('detectTelegram：auth_date 是数字也可以', async () => {
  const w = fakeWin({ bridge: true, webApp: makeWebApp({ authDate: 1764000000 }) });
  const r = await detectTelegram({ win: w });
  assert.equal(r.authDate, 1764000000);
});

test('detectTelegram：SDK 载不到（onerror、onload 但没 WebApp、一直不回）→ tg-broken/offline', async () => {
  for (const sdk of ['error', 'empty', 'never']) {
    const w = fakeWin({ bridge: true, sdk });
    const t0 = Date.now();
    const r = await detectTelegram({ win: w, timeoutMs: 100 });
    assert.deepEqual(r, { mode: 'tg-broken', reason: 'offline' }, sdk);
    assert.ok(Date.now() - t0 < 1000);
  }
});

test('detectTelegram：__tgSdk 一直不回 → 等到 timeoutMs 就当 offline', async () => {
  const w = fakeWin({ bridge: true });
  w.__tgSdk = new Promise(() => {});
  const r = await detectTelegram({ win: w, timeoutMs: 80 });
  assert.deepEqual(r, { mode: 'tg-broken', reason: 'offline' });
});

test('detectTelegram：initData 空、user.id 不合格、auth_date 不合格 → tg-broken/no-init，且有叫 ready()、没叫 expand()', async () => {
  const bads = [
    { initData: '' },
    { initData: undefined },
    { user: undefined },
    { user: { id: 0 } },
    { user: { id: -5 } },
    { user: { id: 1.5 } },
    { user: { id: '12a' } },
    { user: { id: 123456789012345678901 } },
    { authDate: '' },
    { authDate: '0' },
    { authDate: 'abc' },
    { authDate: -1 },
    { authDate: undefined },
  ];
  for (const over of bads) {
    const wa = makeWebApp(over);
    if ('initData' in over) wa.initData = over.initData;
    if ('user' in over) wa.initDataUnsafe.user = over.user;
    if ('authDate' in over) wa.initDataUnsafe.auth_date = over.authDate;
    const w = fakeWin({ bridge: true, webApp: wa });
    const r = await detectTelegram({ win: w });
    assert.deepEqual(r, { mode: 'tg-broken', reason: 'no-init' }, JSON.stringify(over));
    assert.deepEqual(wa.calls, ['ready'], JSON.stringify(over));
  }
});

test('detectTelegram：user.id 是数字字串也可以（1–20 位）', async () => {
  const wa = makeWebApp({ user: { id: '987654321' } });
  const r = await detectTelegram({ win: fakeWin({ bridge: true, webApp: wa }) });
  assert.equal(r.tgId, '987654321');
});

test('detectTelegram：ready／expand 丢错不影响结果；从不 reject', async () => {
  const wa = makeWebApp();
  wa.ready = () => { throw new Error('x'); };
  wa.expand = () => { throw new Error('y'); };
  const r = await detectTelegram({ win: fakeWin({ bridge: true, webApp: wa }) });
  assert.equal(r.mode, 'telegram');
  // 很怪的 win 也不会 reject
  const weird = { get TelegramWebviewProxy() { throw new Error('boom'); } };
  const r2 = await detectTelegram({ win: weird });
  assert.ok(['pwa', 'tg-broken'].includes(r2.mode));
});

// ---------------- initDataLeft、closeMiniApp ----------------

test('initDataLeft：剩几秒（无条件舍去，可为负）', () => {
  assert.equal(initDataLeft(1000, 1000 * 1000, 600), 600);
  assert.equal(initDataLeft(1000, 1000 * 1000 + 500, 600), 599);
  assert.equal(initDataLeft(1000, 1600 * 1000, 600), 0);
  assert.equal(initDataLeft(1000, 1700 * 1000, 600), -100);
});

test('initDataLeft：参数不合格 → 0（当作没时间了）', () => {
  for (const args of [[NaN, 1, 600], [1000, NaN, 600], [1000, 1, Infinity], [undefined, 1, 600], ['1000', 1, 600]]) {
    assert.equal(initDataLeft(...args), 0, JSON.stringify(args));
  }
});

test('closeMiniApp：叫 close；丢错或没有 webApp 都不会当掉', () => {
  const wa = makeWebApp();
  closeMiniApp(wa);
  assert.deepEqual(wa.calls, ['close']);
  assert.doesNotThrow(() => closeMiniApp({ close() { throw new Error('x'); } }));
  assert.doesNotThrow(() => closeMiniApp(null));
});

test('TG_BIND_MAX_SEC：前端与服务器相同', async () => {
  const { TG_BIND_MAX_SEC } = await import('../js/telegram.js');
  const server = await import('../supabase/functions/_shared/telegram.ts');
  assert.equal(TG_BIND_MAX_SEC, 600);
  assert.equal(TG_BIND_MAX_SEC, server.TG_BIND_MAX_SEC);
});
