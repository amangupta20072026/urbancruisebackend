import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    // Tests live in __tests__ folders next to the code they test.
    include: ['src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/modules/auth/__tests__/setup.ts'],

    globals: false,

    coverage: {
      provider: 'v8',
      include: ['src/modules/auth/**/*.ts'],
      exclude: [
        'src/modules/auth/**/__tests__/**',
        'src/modules/auth/**/index.ts',
        'src/modules/auth/infrastructure/testing/**',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
});
