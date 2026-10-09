// CI check: every API route and socket handler declares @Public() or @RequirePermission(...).
// Run from apps/api (`pnpm lint` does). Exits 1 with a list of offenders.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { findUndeclaredRoutes } from '../packages/config/src/route-check';

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) yield full;
  }
}

const root = path.resolve(process.cwd(), process.argv[2] ?? 'src');
const problems = [...sourceFiles(root)].flatMap((f) => findUndeclaredRoutes(readFileSync(f, 'utf8'), f));

if (problems.length) {
  console.error('Routes without @Public() or @RequirePermission():');
  for (const p of problems) console.error(`  ${path.relative(process.cwd(), p.file)}:${p.line}  ${p.route}`);
  process.exit(1);
}
console.log('All routes declare a permission or @Public().');
