import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite: the Lucid store against a real Postgres (docker). Split from
 * `vitest.config.ts` so `pnpm test` stays fast and runs without Docker.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
      },
    }),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/integration/**/*.{spec,test}.ts'],
    globalSetup: ['test/integration/global_setup.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
