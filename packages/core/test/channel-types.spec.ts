import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * The typed `agora:resilience:*` channels reach a consumer that has `@adonis-agora/diagnostics`
 * installed, and an app without diagnostics still compiles. Runs against the published declarations.
 */
describe('typed diagnostics channels (published declarations)', () => {
  const harness = fileURLToPath(new URL('./fixtures/channel-types/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the channel augmentation', () => {
        expect.fail(`${distTypes} does not exist: run \`pnpm build\` before \`pnpm test\`.`);
      });
    } else {
      it.skip('dist/ missing — run `pnpm --filter @adonis-agora/resilience build` first', () => {});
    }
  } else {
    it('narrows agora:resilience:* payloads and compiles without diagnostics', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('channel types: OK');
    }, 90_000);
  }
});
