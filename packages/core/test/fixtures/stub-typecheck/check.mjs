/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/resilience` and `@adonisjs/*` by NAME, with each stub rendered by the
 * REAL AdonisJS stub renderer into the file `node ace configure` actually writes, compiled by a real
 * `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves, and `stubs.spec.ts` proves the stub exists,
 * is not empty and carries the right anchors — but it operates on text, so it cannot see a type
 * error.
 *
 * The gap is not hypothetical twice over. This package shipped its config stub at ZERO bytes through
 * every gate. And `@adonis-agora/agent` shipped a stub that existed, had content, rendered fine, and
 * still did not compile in a consumer app: its structural `rawQuery` declared `bindings?: unknown[]`,
 * not assignable in either direction to Lucid's `RawQueryBindings`, so no real client satisfied it.
 * "Not empty" is a step below "compiles for the person who receives it".
 *
 * WHY THE REAL RENDERER. Rendering with a hand-rolled regex checks a file the generator never
 * writes, and the difference is exactly where bugs hide: Tempura compiles the stub BODY into a JS
 * template literal, so a backtick there makes the real render throw while a regex renderer sails
 * past it. `@adonis-agora/authz` published a `configure` that aborted without writing any file, in
 * every released version, with all its gates green — because its harness rendered the stub itself.
 * This drives the same pipeline `codemods.makeUsingStub` uses, so a stub that cannot be generated
 * fails here.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs — not
 * `src/`, which a check run inside this repo would otherwise pick up. Dropping an export from the
 * root barrel keeps the package's own typecheck green (its internal imports are relative) and fails
 * HERE, with the diagnostic the consumer would get.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Read the stubs from `dist/stubs` rather than the source tree: that is where the published
 * `stubsRoot` points, so it is the copy `node ace configure` reads in an installed app. A build step
 * copies them there, and a stub that fails to be copied is a stub the consumer never receives.
 */
const stubsRoot = join(pkgRoot, 'dist', 'stubs');

/**
 * Every stub `configure` publishes. This one carries the typed `defineConfig` call, so it would
 * break a consumer's build if a published signature drifted.
 */
const STUBS = ['config/resilience.stub'];

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve
 * every peer they import plus anything the published declarations transitively reference (the
 * `@adonisjs/core` application types behind `StoreContext`, luxon via Lucid's types). Scoped
 * directories are recreated as real directories so `@adonis-agora/resilience` can be added alongside
 * without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer is
 * picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → dist/**/*.d.ts.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/resilience'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'resilience-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify(
      { name: 'resilience-stub-typecheck-app', type: 'module', private: true },
      null,
      2,
    ),
  );
  linkDependencies(appRoot);

  // Render through the real pipeline — the same one `codemods.makeUsingStub` drives.
  // `attributes.to` is the destination the generator computes, so each file lands exactly where a
  // consumer would find it.
  const app = new AppFactory().create(new URL(`file://${appRoot}/`));
  await app.init();
  const stubs = await app.stubs.create();

  for (const stubPath of STUBS) {
    const prepared = await (await stubs.build(stubPath, { source: stubsRoot })).prepare({});

    // Anything left unrendered would reach tsc as literal braces — a compile error nobody can
    // explain, or worse, one that gets "fixed" by loosening this check until it looks at nothing.
    const leftover = prepared.contents.match(/\{\{.*?\}\}/);
    if (leftover) {
      throw new Error(`unrendered template syntax ${leftover[0]} left in ${stubPath}`);
    }

    // `to` is absolute and already inside appRoot (the app factory was rooted there).
    const target = prepared.attributes.to;
    if (relative(appRoot, target).startsWith('..')) {
      throw new Error(`${stubPath} renders outside the scratch app: ${target}`);
    }
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, prepared.contents);
  }

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig`
   * sets. Both matter — NodeNext is what makes the package's `exports` map (and therefore its
   * subpath declarations) the thing being resolved, and `strict` is what turns a variance mismatch
   * from a silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
        },
        include: ['config/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  rmSync(appRoot, { recursive: true, force: true });
}

console.log(`stub typecheck: OK (${STUBS.length} stubs, rendered by the real AdonisJS renderer)`);
