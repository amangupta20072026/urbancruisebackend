/**
 * config routes (public, no session), mounted at /api/v1/config.
 *   GET /app        app config, called at cold start before login
 *   GET /brochures  vehicle brochure catalog (YouTube ids, grouping, specs)
 * Covered by the global rate limit only; both are cheap and in-memory.
 */
import { Router } from 'express';
import { validate } from '../../shared/http/middleware/validate.js';
import { AppConfigQuery } from './schemas.js';
import { getAppConfig, getBrochures } from './controller.js';

const router = Router();

router.get('/app', validate({ query: AppConfigQuery }), getAppConfig);

router.get('/brochures', getBrochures);

export default router;
