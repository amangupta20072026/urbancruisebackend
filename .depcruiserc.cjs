/**
 * ==========================================================================
 * dependency-cruiser — architecture enforcement for the modular monolith
 * --------------------------------------------------------------------------
 * Rules mirror the ESLint no-restricted-imports rules. Two enforcement
 * points, one intent — depcruise runs in CI + pre-commit so bad imports
 * fail the build regardless of what the developer's editor caught.
 * ==========================================================================
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ------------------------------------------------------------------
    // 1. Cross-module reach-in: block importing another module's internals
    // ------------------------------------------------------------------
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        "Cross-module imports must go through the target module's index.ts (public API). " +
        'Reaching into service/repository/routes/etc of another module violates the modular boundary.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          // allowed: same module (any depth)
          '^src/modules/$1(/|$)',
          // allowed: another module via its top-level index.ts (public API)
          '^src/modules/[^/]+/index\\.(ts|js)$',
        ],
      },
    },

    // ------------------------------------------------------------------
    // 2. shared/ and config/ must not depend on modules/
    // ------------------------------------------------------------------
    {
      name: 'shared-no-depend-on-modules',
      severity: 'error',
      comment:
        'shared/ and config/ are infrastructure. They must never depend on business modules. ' +
        'Dependency direction is: modules → shared, never the reverse.',
      from: { path: '^src/(shared|config)/' },
      to: { path: '^src/modules/' },
    },

    // ------------------------------------------------------------------
    // 3. Nobody imports from dist/
    // ------------------------------------------------------------------
    {
      name: 'no-import-from-dist',
      severity: 'error',
      comment: 'dist/ is a build artifact. Never import from it.',
      from: {},
      to: { path: '^dist/' },
    },

    // ------------------------------------------------------------------
    // 4. Circular dependencies
    // ------------------------------------------------------------------
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies indicate a design flaw. Extract shared code to shared/.',
      from: {},
      to: { circular: true },
    },

    // ------------------------------------------------------------------
    // 5. No orphaned modules
    // ------------------------------------------------------------------
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable file — either import it somewhere or delete it.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dotfiles
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|webpack)\\.config\\.(js|cjs|mjs|ts|json)$',
        ],
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(?:@[^/]+/[^/]+|[^/]+)' },
      archi: {
        collapsePattern: '^(?:packages|src|lib|app|bin|test(?:s?)|spec(?:s?))/[^/]+|node_modules/(?:@[^/]+/[^/]+|[^/]+)',
      },
    },
  },
};