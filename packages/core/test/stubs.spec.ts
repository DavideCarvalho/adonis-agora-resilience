import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The stubs `node ace configure` publishes are plain files copied into `dist/` by the build, so
 * nothing in the type system or the test suite notices when one is emptied or dropped. It has
 * happened: a commit that removed backticks from the config stub removed the whole file with them,
 * and every consumer got a zero-byte `config/resilience.ts`. These tests are the guard.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every `.stub` file under `dir`, relative to the package root. */
function findStubs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findStubs(full));
    else if (entry.name.endsWith('.stub')) found.push(relative(packageRoot, full));
  }
  return found;
}

// Source stubs, plus the copies the build places in `dist/` when it has already run.
const stubFiles = [
  ...findStubs(join(packageRoot, 'stubs')),
  ...findStubs(join(packageRoot, 'dist', 'stubs')),
];

const CONFIG_STUB = 'stubs/config/resilience.stub';

describe('published stubs', () => {
  it('finds the config stub to check', () => {
    expect(stubFiles).toContain(CONFIG_STUB);
  });

  it.each(stubFiles)('%s is not empty', (file) => {
    const bytes = statSync(join(packageRoot, file)).size;
    expect(bytes, `${file} is empty — configure would publish a blank file`).toBeGreaterThan(0);
  });

  it.each(stubFiles)('%s has no backtick or template placeholder', (file) => {
    // The stub renderer compiles the file body into a JS template literal, so a backtick or a
    // `${` in the stub text is a syntax error at publish time.
    const contents = readFileSync(join(packageRoot, file), 'utf8');
    expect(contents).not.toContain('`');
    expect(contents).not.toContain('${');
  });

  it('publishes a usable config/resilience.ts', () => {
    const contents = readFileSync(join(packageRoot, CONFIG_STUB), 'utf8');
    expect(contents).toContain("exports({ to: app.configPath('resilience.ts') })");
    expect(contents).toContain("import { defineConfig, stores } from '@adonis-agora/resilience'");
    expect(contents).toContain('export default defineConfig({');
  });
});
