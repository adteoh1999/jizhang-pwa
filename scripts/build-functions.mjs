// 把 Edge Function 和它 import 的 _shared 档合成一个文件，方便贴进 Supabase 后台编辑器。
// 用法：node scripts/build-functions.mjs send-email register  → 输出 supabase/dist/<名>.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+['"]\.\.\/_shared\/([\w.-]+\.ts)['"];?\s*$/;

export function bundle(functionsDir, name) {
  const src = readFileSync(join(functionsDir, name, 'index.ts'), 'utf8');
  const done = new Set();
  const out = [`// 自动产生（scripts/build-functions.mjs），不要手改；原始档在 supabase/functions/${name}/`];
  for (const line of src.split('\n')) {
    if (!line.includes('_shared')) { out.push(line); continue; }
    const m = line.match(SHARED_IMPORT);
    if (!m) throw new Error(`看不懂这行 import（要写成单行 import { … } from '../_shared/x.ts'）：${line}`);
    if (/\bas\b/.test(m[1])) throw new Error(`_shared 的 import 不能用 as 改名：${line}`);
    if (done.has(m[2])) continue;
    done.add(m[2]);
    const shared = readFileSync(join(functionsDir, '_shared', m[2]), 'utf8');
    if (/^\s*import\s/m.test(shared)) throw new Error(`_shared/${m[2]} 不能再 import 别的文件`);
    out.push(`// ---- _shared/${m[2]} ----`, shared.trimEnd(), `// ---- end _shared/${m[2]} ----`);
  }
  return out.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../../supabase');
  const names = process.argv.slice(2);
  if (names.length === 0) { console.error('用法：node scripts/build-functions.mjs <函数名> …'); process.exit(1); }
  mkdirSync(join(root, 'dist'), { recursive: true });
  for (const n of names) {
    writeFileSync(join(root, 'dist', `${n}.ts`), bundle(join(root, 'functions'), n) + '\n');
    console.log(`已产生 supabase/dist/${n}.ts`);
  }
}
