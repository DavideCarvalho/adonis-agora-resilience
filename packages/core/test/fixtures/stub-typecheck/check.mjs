/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/resilience` and `@adonisjs/*` by NAME, with each stub rendered into the
 * file it actually generates, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's
 * OWN types, which are trivially happy with themselves, and the sibling `stubs.spec.ts` asserts the
 * stub is non-empty and free of the backticks that break the renderer — but that operates on text,
 * so it cannot see a type error. That leaves a stub free to reference a shape the real types reject
 * while the whole suite stays green.
 *
 * The failure mode is not hypothetical: `@adonis-agora/agent` shipped a migration whose `up()` did
 * not compile in a consumer app, because its structural `rawQuery` declared `bindings?: unknown[]` —
 * not assignable in either direction to Lucid's `RawQueryBindings`, so no per-connection client
 * satisfied it. Its whole suite stayed green. This package has its own version of that exposure:
 * `config/resilience.stub` calls `defineConfig({ default, stores })` and `stores.memory()`, so any
 * drift in those signatures silently breaks the file every consumer receives from `node ace add`.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its
 * `exports` map, so what is checked is the PUBLISHED declarations a consumer installs — not `src/`,
 * which a check run inside this repo would otherwise pick up.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Every stub that generates TYPED TypeScript, with the path `configure` writes it to. A stub that
 * emits no type-bearing code has nothing to check; this one imports from the package and would break
 * a consumer's build if those signatures drifted.
 */
const STUBS = [{ stub: 'config/resilience.stub', to: 'config/resilience.ts' }];

/**
 * Render a stub the way the generator does. One template construct appears in this stub: the
 * `{{{ exports(...) }}}` destination header.
 *
 * Deliberately strict: anything left unrendered is a hard failure rather than a silent pass. A stub
 * that grows a template construct this renderer does not model would otherwise reach `tsc` with
 * literal braces in it — which reads as a compile error nobody can explain, or worse, gets "fixed"
 * by loosening the check until it stops looking at anything.
 */
function render({ stub }) {
  const source = readFileSync(join(pkgRoot, 'stubs', stub), 'utf8');

  let out = source.replace(/^\{\{#var[^\n]*\n/gm, '');
  const withoutHeader = out.replace(/\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (withoutHeader === out) {
    throw new Error(`no {{{ exports() }}} header in ${stub} — render assumption broken`);
  }
  out = withoutHeader;

  const leftover = out.match(/\{\{.*?\}\}/);
  if (leftover) throw new Error(`unrendered template syntax ${leftover[0]} left in ${stub}`);
  return out;
}

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stub resolves
 * every peer it imports plus anything the published declarations transitively reference (the
 * `@adonisjs/core` application types behind `StoreContext`, luxon via Lucid's types). Scoped
 * directories are recreated as real directories so `@adonis-agora/resilience` can be added alongside
 * without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer
 * dependency is picked up automatically instead of failing here as a confusing missing-types error.
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

  // The package under test, resolved BY NAME through its `exports` map → `dist/**/*.d.ts`.
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

  for (const spec of STUBS) {
    const target = join(appRoot, spec.to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, render(spec));
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

console.log(`stub typecheck: OK (${STUBS.length} stubs)`);
