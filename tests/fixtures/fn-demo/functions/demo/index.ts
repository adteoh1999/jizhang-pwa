import { double } from '../_shared/a.ts';
import { PREFIX } from '../_shared/b.ts';

export function handleDemo(n: number): string {
  return PREFIX + double(n);
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve(() => new Response(handleDemo(1)));
