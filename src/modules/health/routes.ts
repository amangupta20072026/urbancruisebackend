/**
 * health routes (public, mounted at /): GET /, /favicon.ico, /robots.txt,
 * /health (liveness), /ready (readiness). Keep them cheap: a slow /ready
 * under load can starve the DB pool.
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
