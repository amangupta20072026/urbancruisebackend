/**
 * ==============================================================================
 * health module — routes (mounted at the application root)
 * ==============================================================================
 *   GET /             — minimal service banner { service, status }
 *   GET /favicon.ico  — 204 No Content (silences browser 404 noise)
 *   GET /robots.txt   — "Disallow: /" (an API has nothing to index)
 *   GET /health       — liveness  (does the process respond?)
 *   GET /ready        — readiness (does the process respond AND can it reach MySQL + Redis?)
 *
 * HEAD is answered automatically for every GET route (Express behaviour).
 * None of these routes require authentication. Nginx bypasses rate-limit for
 * the probes. Keep them cheap — a busy /ready endpoint under load can starve
 * the DB pool.
 *
 * Any other path still falls through to notFound → 404 ROUTE_NOT_FOUND.
 * ==============================================================================
 */
import { Router } from 'express';
import * as controller from './controller.js';

const router = Router();

router.get('/', controller.root);
router.get('/favicon.ico', controller.favicon);
router.get('/robots.txt', controller.robots);
router.get('/health', controller.liveness);
router.get('/ready', controller.readiness);

export default router;
