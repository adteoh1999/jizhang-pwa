// 把 Edge Function 和它 import 的 _shared 档合成一个文件，方便贴进 Supabase 后台编辑器。
// 用法：node scripts/build-functions.mjs send-email register  → 输出 supabase/dist/<名>.ts
// 规则：index.ts 里任何含「_shared」字样的行（包括注释）都必须是单行 import { … } from '../_shared/x.ts'，否则报错停下。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+['"]\.\.\/_shared\/([\w.-]+\.ts)['"];?\s*$/;
// _shared 档里不能出现的东西（再 import 别档、export … from、动态 import）；测试也用这条检查
export const SHARED_IMPORT_FORBIDDEN = /^\s*import\b|\bexport\b[^;]*?\bfrom\s*['"]|\bimport\s*\(/m;

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
    if (SHARED_IMPORT_FORBIDDEN.test(shared)) throw new Error(`_shared/${m[2]} 不能再 import 或 export from 别的文件`);
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
