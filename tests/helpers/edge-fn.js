// Edge Function 测试共用：同时载入原始档与打包后的 dist 档，假 fetch，签钩子
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { bundle } from '../../scripts/build-functions.mjs';

const supa = fileURLToPath(new URL('../../supabase/', import.meta.url));

// 回传 [['原始档', mod], ['打包档', mod]]，同一套测试两个都跑
export async function loadBoth(name) {
  mkdirSync(join(supa, 'dist'), { recursive: true });
  const distFile = join(supa, 'dist', `${name}.ts`);
  writeFileSync(distFile, bundle(join(supa, 'functions'), name) + '\n');
  return [
    ['原始档', await import(pathToFileURL(join(supa, 'functions', name, 'index.ts')).href)],
    ['打包档', await import(pathToFileURL(distFile).href)],
  ];
}

// 假 fetch：routes 是 [[网址片段, (url, init, body) => Response | Promise<Response>], …]
export function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body });
    for (const [part, handler] of routes) {
      if (String(url).includes(part)) return handler(String(url), init, body);
    }
    throw new Error('没有设定的网址：' + url);
  };
  f.calls = calls;
  f.callsTo = (part) => calls.filter((c) => c.url.includes(part));
  return f;
}

export const jsonRes = (status, obj) =>
  new Response(obj === undefined ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// 等到被中断才失败（模拟对方一直不回应）
// （Node 的 AbortSignal.timeout 计时器不会撑住事件循环，所以这里另开一个 5 秒的计时器撑着）
export const hang = (url, init) => new Promise((_, reject) => {
  const keepAlive = setTimeout(() => reject(new Error('测试：超时没有触发')), 5000);
  init.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); });
});

// 测试用钩子 secret（不是真的）
const raw = randomBytes(32);
export const HOOK_SECRET = 'v1,whsec_' + raw.toString('base64');

export function signedRequest(bodyObj, nowSec, { key = raw, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify(bodyObj);
  const id = 'msg_test';
  const sig = 'v1,' + createHmac('sha256', key).update(`${id}.${nowSec}.${body}`).digest('base64');
  return new Request('https://p.supabase.co/functions/v1/send-email', {
    method: 'POST',
    headers: { 'webhook-id': id, 'webhook-timestamp': String(nowSec), 'webhook-signature': sig, 'Content-Type': 'application/json' },
    body,
  });
}

export const envOf = (o) => (k) => o[k];
