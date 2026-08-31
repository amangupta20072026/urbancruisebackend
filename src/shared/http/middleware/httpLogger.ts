/**
 * ==============================================================================
 * httpLogger — re-export from shared/logger with a name that reads well in app.ts
 * ==============================================================================
 * Just a thin re-export so app.ts reads `import { httpLogger } from './middleware/httpLogger.js'`
 * instead of reaching across into `shared/logger`. Keeps app.ts free of
 * infrastructure details.
 * ==============================================================================
 */
export { httpLogger } from '../../logger/httpLogger.js';
