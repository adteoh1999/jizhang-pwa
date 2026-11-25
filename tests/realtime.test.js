// 2e-3 Task 5：Realtime 门铃（js/realtime.js）。假 WebSocket ＋ 假时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtime, realtimeUrl, HEARTBEAT_MS, SUBSCRIBE_TIMEOUT_MS, RECONNECT_MAX_MS } from '../js/realtime.js';
import { SUPABASE_KEY } from '../js/config.js';

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
function fakeClock(start = Date.parse('2026-11-25T10:00:00Z')) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

class FakeWS {
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  open() { this.onopen && this.onopen({}); }
  recv(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
  drop() { this.onclose && this.onclose({}); }
  get join() { return this.sent.find((m) => m.event === 'phx_join'); }
}
FakeWS.all = [];

const IDS = [11, 12, 13, 14];
async function setup({ getSession } = {}) {
  FakeWS.all = [];
  const clock = fakeClock();
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const allowedRef = { v: true };
  const onlineRef = { v: true };
  const tokens = [];
  let pokes = 0;
  const rt = createRealtime({
    userId: 'u-1',
    getSession: getSession || (async (failed) => { tokens.push(failed); return { session: { access_token: `tok-${tokens.length}` } }; }),
    onPoke: () => { pokes++; },
    allowed: () => allowedRef.v,
    WebSocketImpl: FakeWS,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    win, doc, isOnline: () => onlineRef.v,
    url: 'wss://example.invalid/realtime/v1/websocket?apikey=k&vsn=1.0.0',
  });
  const last = () => FakeWS.all[FakeWS.all.length - 1];
  // 连上：open → join ok（带 ids）→ Subscribed to PostgreSQL
  const subscribe = async (ws = last()) => {
    ws.open();
    const j = ws.join;
    ws.recv({ topic: j.topic, event: 'phx_reply', ref: j.ref, payload: { status: 'ok', response: { postgres_changes: IDS.map((id) => ({ id })) } } });
    ws.recv({ topic: j.topic, event: 'system', payload: { status: 'ok', extension: 'postgres_changes', message: 'Subscribed to PostgreSQL', channel: 'ledger-u-1' } });
    await settle();
  };
  return { rt, clock, win, doc, allowedRef, onlineRef, tokens, pokes: () => pokes, last, subscribe };
}

test('网址：wss、publishable key、vsn=1.0.0；不带使用者 token', () => {
  const u = new URL(realtimeUrl());
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.pathname, '/realtime/v1/websocket');
  assert.equal(u.searchParams.get('apikey'), SUPABASE_KEY);
  assert.equal(u.searchParams.get('vsn'), '1.0.0');
  assert.equal([...u.searchParams.keys()].sort().join(','), 'apikey,vsn');
});

test('join：topic 带 uid；只订 INSERT / UPDATE（不用 *）；filter 限自己；token 在 payload', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  assert.equal(r.rt.state(), 'connecting');
  const ws = r.last();
  ws.open();
  const j = ws.join;
  assert.equal(j.topic, 'realtime:ledger-u-1');
  assert.equal(j.ref, j.join_ref);
  assert.equal(j.payload.access_token, 'tok-1');
  assert.equal(j.payload.config.private, false);
  const pc = j.payload.config.postgres_changes;
  assert.deepEqual(pc.map((x) => `${x.event} ${x.schema}.${x.table} ${x.filter}`).sort(), [
    'INSERT public.categories user_id=eq.u-1', 'INSERT public.transactions user_id=eq.u-1',
    'UPDATE public.categories user_id=eq.u-1', 'UPDATE public.transactions user_id=eq.u-1',
  ]);
  assert.ok(!ws.url.includes('tok-'));
  r.rt.stop();
});

test('join ok → 补拉一次；Subscribed to PostgreSQL → live、再补拉一次', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  assert.equal(r.rt.state(), 'live');
  assert.equal(r.pokes(), 2);
  r.rt.stop();
});

test('postgres_changes 事件 ids 对得上 → 按门铃；broadcast 或别的事件 → 不按', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  const ws = r.last();
  const topic = ws.join.topic;
  ws.recv({ topic, event: 'postgres_changes', payload: { ids: [12], data: { type: 'UPDATE', table: 'transactions' } } });
  assert.equal(r.pokes(), 3);
  ws.recv({ topic, event: 'broadcast', payload: { event: 'x', payload: {} } });
  ws.recv({ topic: 'realtime:other', event: 'postgres_changes', payload: { ids: [12] } });
  ws.recv({ topic, event: 'presence_state', payload: {} });
  assert.equal(r.pokes(), 3);
  assert.equal(ws.closed, false);
  r.rt.stop();
});

test('事件 ids 都对不上 → 当成订阅坏了：关线、重连', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  const ws = r.last();
  ws.recv({ topic: ws.join.topic, event: 'postgres_changes', payload: { ids: [999], data: {} } });
  assert.equal(r.pokes(), 2);
  assert.equal(ws.closed, true);
  await r.clock.advance(1000);
  assert.equal(FakeWS.all.length, 2);
  r.rt.stop();
});

test('system error／phx_close／phx_error／socket 断线 → 关线、退避重连', async () => {
  for (const kill of [
    (ws) => ws.recv({ topic: ws.join.topic, event: 'system', payload: { status: 'error', extension: 'postgres_changes', message: 'boom' } }),
    (ws) => ws.recv({ topic: ws.join.topic, event: 'phx_close', payload: {} }),
    (ws) => ws.recv({ topic: ws.join.topic, event: 'phx_error', payload: {} }),
    (ws) => ws.drop(),
  ]) {
    const r = await setup();
    r.rt.start();
    await settle();
    await r.subscribe();
    kill(r.last());
    assert.equal(r.rt.state(), 'connecting');
    await r.clock.advance(1000);
    assert.equal(FakeWS.all.length, 2);
    r.rt.stop();
  }
});

test('心跳：每 25 秒一次；上一次没回覆 → 重连', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  const ws = r.last();
  await r.clock.advance(HEARTBEAT_MS);
  const hb = ws.sent.filter((m) => m.topic === 'phoenix' && m.event === 'heartbeat');
  assert.equal(hb.length, 1);
  ws.recv({ topic: 'phoenix', event: 'phx_reply', ref: hb[0].ref, payload: { status: 'ok', response: {} } });
  await r.clock.advance(HEARTBEAT_MS);
  assert.equal(ws.closed, false);
  assert.equal(ws.sent.filter((m) => m.event === 'heartbeat').length, 2);
  await r.clock.advance(HEARTBEAT_MS); // 第二次没回
  assert.equal(ws.closed, true);
  r.rt.stop();
});

test('15 秒内没收到 Subscribed → 重连', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  const ws = r.last();
  ws.open();
  await r.clock.advance(SUBSCRIBE_TIMEOUT_MS);
  assert.equal(ws.closed, true);
  r.rt.stop();
});

test('退避：1、2、4…秒，上限 60 秒；live 之后归零', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  const gaps = [];
  for (let i = 0; i < 9; i++) {
    const before = r.clock.now();
    r.last().drop();
    const n = FakeWS.all.length;
    while (FakeWS.all.length === n) await r.clock.advance(500);
    gaps.push(r.clock.now() - before);
  }
  assert.deepEqual(gaps.slice(0, 4), [1000, 2000, 4000, 8000]);
  assert.equal(Math.max(...gaps), RECONNECT_MAX_MS);
  await r.subscribe();
  const before = r.clock.now();
  r.last().drop();
  const n = FakeWS.all.length;
  while (FakeWS.all.length === n) await r.clock.advance(500);
  assert.equal(r.clock.now() - before, 1000);
  r.rt.stop();
});

test('join 被拒（token）→ 下一次用失败的 token 强制刷新；同一条重连链只强制一次', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  const reject = async () => {
    const ws = r.last();
    ws.open();
    const j = ws.join;
    ws.recv({ topic: j.topic, event: 'phx_reply', ref: j.ref, payload: { status: 'error', response: { reason: 'InvalidJWTToken: Token has expired 5 seconds ago' } } });
    const n = FakeWS.all.length;
    while (FakeWS.all.length === n) await r.clock.advance(500);
  };
  await reject();
  await reject();
  await reject();
  assert.deepEqual(r.tokens, [null, 'tok-1', null, null]);
  r.rt.stop();
});

test('getSession 回 invalid（登录过期）→ 不连线、状态 off', async () => {
  const r = await setup({ getSession: async () => ({ invalid: true }) });
  r.rt.start();
  await r.clock.advance(120_000);
  assert.equal(FakeWS.all.length, 0);
  assert.equal(r.rt.state(), 'off');
  r.rt.stop();
});

test('切到背景 → 关线、不重连；回前景 → 开新连线（不信旧的）', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  const ws = r.last();
  r.doc.visibilityState = 'hidden';
  r.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(ws.closed, true);
  assert.equal(r.rt.state(), 'off');
  await r.clock.advance(120_000);
  assert.equal(FakeWS.all.length, 1);
  r.doc.visibilityState = 'visible';
  r.doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(FakeWS.all.length, 2);
  await r.subscribe();
  assert.equal(r.pokes(), 4); // 回前景的新连线也补拉
  r.rt.stop();
});

test('pagehide → 关线；pageshow → 重开；offline → 关线；online → 重开', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  r.win.dispatchEvent(new Event('pagehide'));
  assert.equal(r.last().closed, true);
  r.win.dispatchEvent(new Event('pageshow'));
  await settle();
  assert.equal(FakeWS.all.length, 2);
  r.onlineRef.v = false;
  r.win.dispatchEvent(new Event('offline'));
  assert.equal(r.last().closed, true);
  assert.equal(r.rt.state(), 'off');
  r.onlineRef.v = true;
  r.win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(FakeWS.all.length, 3);
  r.rt.stop();
});

test('allowed() 为 false（登出、换账号、还没认领）→ 不连；check() 之后照新状态开关', async () => {
  const r = await setup();
  r.allowedRef.v = false;
  r.rt.start();
  await settle();
  assert.equal(FakeWS.all.length, 0);
  r.allowedRef.v = true;
  r.rt.check();
  await settle();
  assert.equal(FakeWS.all.length, 1);
  await r.subscribe();
  r.allowedRef.v = false;
  r.rt.check();
  assert.equal(r.last().closed, true);
  assert.equal(r.rt.state(), 'off');
  r.rt.stop();
});

test('stop 之后：关线、不再连、不再按门铃', async () => {
  const r = await setup();
  r.rt.start();
  await settle();
  await r.subscribe();
  const ws = r.last();
  r.rt.stop();
  assert.equal(ws.closed, true);
  ws.recv({ topic: ws.join.topic, event: 'postgres_changes', payload: { ids: [11] } });
  r.doc.dispatchEvent(new Event('visibilitychange'));
  await r.clock.advance(120_000);
  assert.equal(FakeWS.all.length, 1);
  assert.equal(r.pokes(), 2);
  assert.equal(r.rt.state(), 'off');
});

test('subscribe：状态改变时通知（off → connecting → live）', async () => {
  const r = await setup();
  const seen = [];
  r.rt.subscribe((s) => seen.push(s));
  r.rt.start();
  await settle();
  await r.subscribe();
  assert.deepEqual(seen, ['connecting', 'live']);
  r.rt.stop();
});

test('App 接线：门铃用一般排程（尊重退避）；同步状态变就重新判断；sync 启动后才连；sw 离线清单有 realtime.js', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(app, /onPoke: \(\) => sync\.schedule\(\)/);
  assert.match(app, /sync\.subscribe\(\(\) => realtime\.check\(\)\)/);
  assert.ok(app.indexOf('realtime.start()') > app.indexOf('sync.start()'));
  for (const st of ['signed-out', 'stale', 'other-owner', 'unclaimed', 'stopped']) assert.ok(app.includes(`'${st}'`));
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes("'./js/realtime.js'"));
});
