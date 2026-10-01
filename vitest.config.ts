import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node's native ESM so import.meta and .js extensions work
    // exactly as they do in production (no transform tricks).
    environment: 'node',

    // Match only files we put in __tests__ directories.
    // Keeps test files co-located with the modules they test.
    include: ['src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/modules/auth/__tests__/setup.ts'],

    // Never import from env.ts at test time — individual tests
    // supply any ENV values they need.  If a test file transitively
    // reaches env.ts and the required vars are absent, the import will
    // throw, which is intentional (force explicit mocking).
    globals: false,

    // Coverage with v8 (built-in, no babel needed)
    coverage: {
      provider: 'v8',
      include: ['src/modules/auth/**/*.ts'],
      exclude: [
        'src/modules/auth/**/__tests__/**',
        'src/modules/auth/**/index.ts', // barrels
        'src/modules/auth/infrastructure/testing/**', // fakes are not production code
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
