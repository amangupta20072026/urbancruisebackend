/**
 * ==============================================================================
 * health module — controller
 * ==============================================================================
 * Two probes with different semantics:
 *
 *   liveness  — "is the process alive?" — no DB dep. Never fails unless the
 *               process is deadlocked. K8s / PM2 use it to decide when to
 *               restart.
 *   readiness — "can the process do useful work?" — pings the DB. Fails
 *               (503) if the DB is unreachable. Load balancer uses it to
 *               decide whether to route traffic here.
 *
 * The readiness endpoint is single-request per second at most from
 * orchestrators — it does not need caching.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { ok } from '../../shared/http/responses.js';
import { ping } from '../../shared/db/pool.js';
import { logger } from '../../shared/logger/index.js';
import { nowIso } from '../../shared/utils/datetime.js';

/** GET /health — 200 if process is up. */
export const liveness: RequestHandler = (_req, res) => {
  ok(res, { status: 'live', time: nowIso() });
};

/** GET /ready — 200 if DB reachable, 503 otherwise. */
export const readiness: RequestHandler = async (_req, res) => {
  try {
    await ping();
    ok(res, { status: 'ready', db: 'ok', time: nowIso() });
  } catch (err) {
    logger.warn({ err }, 'readiness probe failed');
    // Don't leak DB details — just say we're not ready.
    res.status(503).json({
      error: { code: 'NOT_READY', message: 'Service not ready.', requestId: String(res.req.id) },
    });
  }
};
