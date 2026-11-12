/**
 * Type-checks the `agora:resilience:*` channel augmentation the way a consumer app sees it: a scratch
 * app resolves `@adonis-agora/resilience` BY NAME (its published `dist/**\/*.d.ts`) next to a stand-in
 * for `@adonis-agora/diagnostics` that declares the same `ChannelRegistry` / `PayloadOf` shapes the
 * real package does, and `app.ts` asserts the payload types. Three apps:
 *  - `auto`: diagnostics is resolvable from the installed package (npm/yarn layout): the shipped
 *    augmentation applies on its own;
 *  - `app-side`: it is not (pnpm's strict layout): the app's own three-line augmentation applies;
 *  - `none`: no diagnostics at all still compiles.
 *
 * Exits 0 on success; prints tsc's diagnostics and exits non-zero otherwise.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
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

const DIAGNOSTICS_SHIM = `
export interface ChannelRegistry {}
type LooseString = string & {};
export type LibOf = (keyof ChannelRegistry & string) | LooseString;
export type EventOf<TLib extends string> = TLib extends keyof ChannelRegistry
  ? (keyof ChannelRegistry[TLib] & string) | LooseString
  : string;
export type PayloadOf<TLib extends string, TEvent extends string> = TLib extends keyof ChannelRegistry
  ? TEvent extends keyof ChannelRegistry[TLib]
    ? ChannelRegistry[TLib][TEvent]
    : unknown
  : unknown;
export declare function emit<TLib extends LibOf, TEvent extends EventOf<TLib>>(
  lib: TLib, event: TEvent, payload: PayloadOf<TLib, TEvent>): void;
`;

const ASSERTIONS = `
import type { PayloadOf } from '@adonis-agora/diagnostics';
import { emit } from '@adonis-agora/diagnostics';
import '@adonis-agora/resilience';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};

assert<Equal<PayloadOf<'resilience', 'circuit-opened'>['key'], string>>();
assert<Equal<PayloadOf<'resilience', 'circuit-opened'>['policy'], string | undefined>>();
assert<Equal<PayloadOf<'resilience', 'executed'>['ok'], boolean>>();
assert<Equal<PayloadOf<'resilience', 'retry'>['attempt'], number>>();
assert<Equal<PayloadOf<'resilience', 'not-a-channel'>, unknown>>();

emit('resilience', 'timeout', { type: 'timeout', ms: 5 });
// @ts-expect-error a timeout carries ms, not key
emit('resilience', 'timeout', { type: 'timeout', key: 'x' });
emit('other-lib', 'anything', { free: 'form' });
`;

const APP_SIDE = `
import type { ResilienceChannels } from '@adonis-agora/resilience';
declare module '@adonis-agora/diagnostics' {
  interface ChannelRegistry {
    resilience: ResilienceChannels;
  }
}
${ASSERTIONS}`;

const WITHOUT_DIAGNOSTICS = `
import { ResilienceService } from '@adonis-agora/resilience';
export const service = new ResilienceService();
`;

/** @param {'auto' | 'app-side' | 'none'} mode */
function scratchApp(mode, source) {
  const withDiagnostics = mode !== 'none';
  const appRoot = mkdtempSync(join(tmpdir(), 'resilience-channel-types-'));
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'app', type: 'module', private: true }),
  );
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.') || entry === '@adonis-agora') continue;
    symlinkSync(join(from, entry), join(to, entry));
  }
  const installed = join(to, '@adonis-agora/resilience');
  if (mode === 'auto') {
    // A real directory next to diagnostics, as npm installs it: the augmentation resolves from here.
    mkdirSync(installed);
    cpSync(join(pkgRoot, 'package.json'), join(installed, 'package.json'));
    cpSync(join(pkgRoot, 'dist'), join(installed, 'dist'), { recursive: true });
  } else {
    symlinkSync(pkgRoot, installed);
  }
  if (withDiagnostics) {
    const dir = join(to, '@adonis-agora/diagnostics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@adonis-agora/diagnostics',
        type: 'module',
        exports: { '.': { types: './index.d.ts' } },
      }),
    );
    writeFileSync(join(dir, 'index.d.ts'), DIAGNOSTICS_SHIM);
  }
  writeFileSync(join(appRoot, 'app.ts'), source);
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: ['node'],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      files: ['app.ts'],
    }),
  );
  return appRoot;
}

for (const [mode, source] of [
  ['auto', ASSERTIONS],
  ['app-side', APP_SIDE],
  ['none', WITHOUT_DIAGNOSTICS],
]) {
  const appRoot = scratchApp(mode, source);
  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error(`channel types: FAILED (${mode})`);
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
  }
}
console.log('channel types: OK');
