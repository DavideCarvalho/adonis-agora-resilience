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

/**
 * The stub body: everything outside the `{{{ … }}}` headers. The header is JS the renderer evaluates
 * to compute the destination; the body is the template text it compiles into a JS template literal.
 * Only the body is subject to the backtick restriction.
 */
function stubBody(contents: string): string {
  return contents.replace(/\{\{\{[\s\S]*?\}\}\}/g, '');
}

const CONFIG_STUB = 'stubs/config/resilience.stub';

describe('published stubs', () => {
  it('finds the config stub to check', () => {
    expect(stubFiles).toContain(CONFIG_STUB);
  });

  it.each(stubFiles)('%s is not empty', (file) => {
    const bytes = statSync(join(packageRoot, file)).size;
    expect(bytes, `${file} is empty — configure would publish a blank file`).toBeGreaterThan(0);
  });

  it.each(stubFiles)('%s has no backtick or template placeholder in its body', (file) => {
    // The renderer compiles the stub BODY into a JS template literal, so a backtick or a `${` there
    // is a syntax error at generate time — `node ace configure` throws and writes nothing.
    //
    // Scoped to the body on purpose. The `{{{ … }}}` header is JS the renderer EVALUATES rather than
    // template text, so backticks are legitimate inside it, and a migration stub needs them to build
    // its timestamped destination. Asserting over the whole file would forbid a construct the engine
    // requires.
    const body = stubBody(readFileSync(join(packageRoot, file), 'utf8'));
    expect(body).not.toContain('`');
    expect(body).not.toContain('${');
  });

  it('publishes a usable config/resilience.ts', () => {
    const contents = readFileSync(join(packageRoot, CONFIG_STUB), 'utf8');
    expect(contents).toContain("exports({ to: app.configPath('resilience.ts') })");
    expect(contents).toContain("import { defineConfig, stores } from '@adonis-agora/resilience'");
    expect(contents).toContain('export default defineConfig({');
  });
});
