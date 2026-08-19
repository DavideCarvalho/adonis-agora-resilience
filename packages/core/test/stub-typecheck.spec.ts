import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template that
 * no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace add` / `node ace configure`. The package's own typecheck compiles `src/` against the
 * library's own types, which are trivially happy with themselves; the sibling `stubs.spec.ts` asserts
 * the stub is non-empty and free of the backticks that break the renderer, but it operates on text
 * and cannot see a type error.
 *
 * The failure mode is not hypothetical: `@adonis-agora/agent` shipped a migration whose `up()` did
 * not compile in a consumer app, because its structural `rawQuery` declared `bindings?: unknown[]` —
 * not assignable in either direction to Lucid's `RawQueryBindings`, so no per-connection client
 * satisfied it. Its whole suite stayed green.
 *
 * The exposure here is `config/resilience.stub`: it calls `defineConfig({ default, stores })` and
 * `stores.memory()`, so a change to either signature — or a symbol dropped from the root export map,
 * which the package's own relative imports cannot notice — breaks the file every consumer receives
 * while nothing else turns red.
 *
 * The stub is compiled under NodeNext + strict with the package resolved BY NAME, so what is checked
 * is the shipped `dist/**\/*.d.ts` a consumer installs, not `src/`.
 */
describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  // Resolving the package by name makes a built package a precondition: a hard failure under CI
  // (where `pnpm test` gates the publish), a convenience skip on a developer machine that has not
  // built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated config COMPILES for a consumer; under CI a',
            'missing build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ missing — run `pnpm --filter @adonis-agora/resilience build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Adonis declaration graph is a few seconds; 90s is a ceiling that will not
    // flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
