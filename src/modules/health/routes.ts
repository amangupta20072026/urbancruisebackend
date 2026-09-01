/**
 * ==============================================================================
 * health module — routes
 * ==============================================================================
 *   GET /health   — liveness  (does the process respond?)
 *   GET /ready    — readiness (does the process respond AND can it reach the DB?)
 *
 * Neither route requires authentication. Nginx bypasses rate-limit for these.
 * Keep them cheap — a busy /ready endpoint under load can starve the DB pool.
 * ==============================================================================
 */
import { Router } from 'express';
import * as controller from './controller.js';

const router = Router();

router.get('/health', controller.liveness);
router.get('/ready', controller.readiness);

export default router;
