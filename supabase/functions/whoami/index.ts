// 临时函数：看平台把用户 IP 放在哪个 header（计划 2c-4）。测完就删掉。
// 只回传和 IP 有关的 header 值；其他 header 只回名字，绝不回传 authorization、apikey、cookie 的值。
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip',
  'forwarded', 'x-envoy-external-address', 'fly-client-ip', 'x-cluster-client-ip', 'cf-ipcountry'];

export function handleWhoami(req: Request): Response {
  const ip: Record<string, string> = {};
  for (const h of IP_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) ip[h] = v;
  }
  const names: string[] = [];
  req.headers.forEach((_v, k) => names.push(k));
  return new Response(JSON.stringify({ ip_headers: ip, all_header_names: names.sort() }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve((req: Request) => handleWhoami(req));
