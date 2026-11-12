import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      // TC39 stage-3 decorators (matches tsc default; no experimentalDecorators in tsconfig)
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
      },
    }),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{spec,test}.ts', 'test/**/*.{spec,test}.ts'],
    exclude: ['test/integration/**', '**/node_modules/**'],
    pool: 'forks',
  },
});
