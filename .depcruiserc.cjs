/**
 * dependency-cruiser: enforces module boundaries. Run with `npm run depcruise`
 * (also runs in the pre-commit hook).
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
        "Cross-module imports are only allowed via the target module's index.ts " +
        'public API. Anything else breaks encapsulation.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(?!index\\.ts$).+',
        pathNot: '^src/modules/$1/', // imports within the same module are allowed
      },
    },
    {
      name: 'sub-modules-siblings-forbidden',
      severity: 'error',
      comment:
        'Business sub-modules of the same parent must not import each other. ' +
        'The auth module is excluded because its second-level folders are ' +
        'architectural layers, not peer business sub-modules.',
      from: {
        path: '^src/modules/([^/]+)/([^/]+)/',
        pathNot: '^src/modules/(auth|notifications)/',
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
