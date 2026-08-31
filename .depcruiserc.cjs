/**
 * ==============================================================================
 * dependency-cruiser — architecture boundary enforcement
 * ==============================================================================
 * Enforces the modular-monolith invariants:
 *
 *   1. `shared/` NEVER imports from `modules/`.
 *   2. A module NEVER imports another module's internals — only its `index.ts`.
 *   3. Sub-modules of the same parent NEVER import each other — only the
 *      parent's index composes them.
 *   4. No circular dependencies anywhere.
 *   5. Nothing imports test/dev-only code from production code.
 *
 * Run:
 *     npm run depcruise
 *
 * Also runs in `.husky/pre-commit`, so bad imports fail before landing on main.
 * ==============================================================================
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular deps make the module graph impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-not-from-modules',
      severity: 'error',
      comment:
        '`shared/` is infrastructure. It MUST NOT depend on any business module. ' +
        'If shared code needs to know about a module, it belongs INSIDE that module.',
      from: { path: '^src/shared/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'modules-only-import-siblings-index',
      severity: 'error',
      comment:
        'Cross-module imports are only allowed via the target module\'s index.ts ' +
        'public API. Anything else breaks encapsulation.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(?!index\\.ts$).+',
        pathNot: '^src/modules/$1/', // same module — internal imports OK
      },
    },
    {
      name: 'sub-modules-siblings-forbidden',
      severity: 'error',
      comment:
        'Sub-modules of the same parent must not import each other. The parent ' +
        'index.ts composes them.',
      from: {
        path: '^src/modules/([^/]+)/([^/]+)/',
      },
      to: {
        path: '^src/modules/$1/(?!$2)([^/]+)/',
      },
    },
    {
      name: 'not-to-test',
      severity: 'error',
      comment: 'Production code must never import test-only code.',
      from: { pathNot: '\\.spec\\.|\\.test\\.|__tests__' },
      to: { path: '\\.spec\\.|\\.test\\.|__tests__' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Files that no one imports may be dead code.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$',
          '\\.d\\.ts$',
          'src/index\\.ts$',
          '\\.config\\.(js|ts|mjs|cjs)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
