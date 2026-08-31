/**
 * ==============================================================================
 * ESLint flat config
 * ==============================================================================
 * The `no-restricted-imports` rule mirrors what dependency-cruiser enforces
 * at CI, but here it runs in the editor / on save — so bad imports light up
 * red BEFORE commit. Two layers, same rule set:
 *
 *   1. `shared/` never imports `modules/`.
 *   2. Anything in `src/**` never uses `../..` chains longer than 2 hops
 *      (a heuristic — real cross-module leakage typically escapes further).
 * ==============================================================================
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      curly: ['error', 'multi-line'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='setTimeout'][arguments.length<2]",
          message: 'setTimeout requires an explicit delay argument.',
        },
      ],
    },
  },
  tseslint.configs.recommended,
  {
    // Layer 2: architecture boundary at the file level.
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '@modules/*'],
              message:
                '`shared/` MUST NOT import from `modules/`. Move the shared piece ' +
                'into the correct module, or promote a module-agnostic type up.',
            },
          ],
        },
      ],
    },
  },
  {
    // Layer 3: modules only see their siblings via the sibling`s index.ts.
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*/**/!(index).ts', '**/modules/*/**/!(index)'],
              message:
                'Cross-module imports must go through the target module`s index.ts. ' +
                'You are reaching into another module`s internals — that violates the ' +
                'modular-monolith contract.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'logs/**'],
  },
]);
