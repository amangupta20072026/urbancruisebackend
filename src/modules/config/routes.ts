/**
 * ==============================================================================
 * config — routes
 * ==============================================================================
 * Public paths (NO auth middleware — this is called before login):
 *   GET /config/app          — server-driven app config + version policy
 *
 * The global rate limit in app.ts is sufficient for this endpoint (it's
 * called at cold start, ~once per app open, and hits an in-memory config).
 * No per-endpoint limiter needed.
 * ==============================================================================
 */
import { Router } from 'express';
import { validate } from '../../shared/http/middleware/validate.js';
import { AppConfigQuery } from './schemas.js';
import { getAppConfig } from './controller.js';

const router = Router();

router.get('/app', validate({ query: AppConfigQuery }), getAppConfig);

export default router;
