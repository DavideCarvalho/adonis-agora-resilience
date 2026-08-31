#!/usr/bin/env node
/**
 * Sync the `export const VERSION = '...'` literal in each package's
 * `src/index.ts` with the `version` field of that package's `package.json`.
 *
 * `tsc`/`tsup` bake the literal into the build as-is, so when
 * `changeset version` bumps `package.json` the source const is left stale
 * (the published `dist` then reports the wrong version). Chaining this script
 * after `changeset version` keeps the two in lockstep.
 *
 * Usage: `node scripts/sync-version.mjs` (run from the repo root).
 * Idempotent. Exits non-zero if any package was rewritten while in `--check`
 * mode so it can double as a CI guard against drift.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
const checkOnly = process.argv.includes('--check');

const VERSION_RE = /(export const VERSION = )(['"])(.*?)\2/;

let drifted = 0;

for (const name of readdirSync(packagesDir)) {
  const pkgJsonPath = join(packagesDir, name, 'package.json');
  const indexPath = join(packagesDir, name, 'src', 'index.ts');

  let pkgJson;
  let source;
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    source = readFileSync(indexPath, 'utf8');
  } catch {
    continue; // no package.json or no src/index.ts — nothing to sync
  }

  const match = source.match(VERSION_RE);
  if (!match) continue; // package doesn't export a VERSION const

  const current = match[3];
  const desired = pkgJson.version;
  if (current === desired) continue;

  drifted += 1;
  if (checkOnly) {
    console.error(
      `VERSION drift in ${name}: src/index.ts has '${current}', package.json has '${desired}'`,
    );
    continue;
  }

  const next = source.replace(VERSION_RE, `$1$2${desired}$2`);
  writeFileSync(indexPath, next);
  console.log(`synced ${name}: VERSION '${current}' -> '${desired}'`);
}

if (checkOnly && drifted > 0) {
  console.error(
    `\n${drifted} package(s) have a stale VERSION const. Run: node scripts/sync-version.mjs`,
  );
  process.exit(1);
}
