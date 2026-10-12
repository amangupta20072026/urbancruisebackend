/**
 * config routes (public, called before login): GET /app.
 * Covered by the global rate limit only; it's cheap and in-memory.
 */
import { Router } from 'express';
import { validate } from '../../shared/http/middleware/validate.js';
import { AppConfigQuery } from './schemas.js';
import { getAppConfig } from './controller.js';

const router = Router();

router.get('/app', validate({ query: AppConfigQuery }), getAppConfig);

export default router;
