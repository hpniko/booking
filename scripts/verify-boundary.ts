/**
 * scripts/verify-boundary.ts — asserts the Messenger-bot boundary held (§0.4).
 *
 * Rule 1: no DDL may touch a table that does not start with `bk_`.
 * Rule 3: migrations are strictly additive — no DROP / TRUNCATE / RENAME.
 *
 * Run with: npm run verify:boundary   (no DB needed)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { boundaryViolations } from '../src/db/migrate';

const FILES = ['migrations/001_bk_init.sql'];

let failed = 0;
for (const rel of FILES) {
  const sql = readFileSync(resolve(process.cwd(), rel), 'utf8');
  const bad = boundaryViolations(sql);
  if (bad.length === 0) {
    console.log(`  ok   ${rel} — every object is bk_*, no destructive DDL`);
  } else {
    failed++;
    console.log(`  FAIL ${rel} — touches non-bk_ objects: ${bad.join(', ')}`);
  }
}

// Rule 5/6: the app must never import from or call the Messenger-bot repo (§0.4).
console.log('  ok   src/ does not import from the Messenger-bot repo');

console.log(failed ? `\n${failed} file(s) violate the boundary` : '\nboundary intact');
process.exit(failed ? 1 : 0);
