/**
 * ==============================================================================
 * health module — controller (probes + root-level endpoints)
 * ==============================================================================
 * Two probes with different semantics:
 *
 *   liveness  — "is the process alive?" — no dependency checks. Never fails
 *               unless the process is deadlocked. Orchestrators (e.g. a K8s
 *               livenessProbe) use it to decide when to restart. Note: PM2
 *               does NOT poll HTTP — it restarts on crash / memory limit.
 *   readiness — "can the process do useful work?" — pings MySQL AND Redis.
 *               Fails (503) if either is unreachable. The load balancer uses
 *               it to decide whether to route traffic here.
 *
 * Why Redis is a readiness dependency: every authenticated request checks the
 * JWT denylist in Redis, every rate limiter keeps its counters there, and the
 * whole OTP flow (sessions, cooldowns, idempotency, onboarding tickets) lives
 * there. With MySQL up but Redis down, almost nothing works — reporting
 * "ready" in that state would keep traffic flowing to a broken worker.
 *
 * Probe behaviour:
 *   - Checks run in PARALLEL, each capped at READINESS_CHECK_TIMEOUT_MS, so
 *     the probe always answers promptly — even when a dependency hangs.
 *   - The body reports per-dependency status ('ok' | 'down') on both 200 and
 *     503. Only the status word is exposed; hostnames, error messages and
 *     stack traces go to the logs, never to the response.
 *   - Responses are marked no-store: a cached "ready" is worse than none.
 *
 * The readiness endpoint is hit at most ~1 rps by orchestrators — it does not
 * need caching or its own rate limit (Nginx bypasses the limiter for it).
 * ==============================================================================
 */
import type { RequestHandler, Response } from 'express';
import { READINESS_CHECK_TIMEOUT_MS } from '../../config/constants.js';
import { ok } from '../../shared/http/responses.js';
import { ping as pingDb } from '../../shared/db/pool.js';
import { pingRedis } from '../../shared/redis/client.js';
import { logger } from '../../shared/logger/index.js';
import { nowIso } from '../../shared/utils/datetime.js';
import type { ErrorEnvelope } from '../../shared/types/api.js';

export type DependencyStatus = 'ok' | 'down';

export type ReadinessChecks = {
  db: DependencyStatus;
  redis: DependencyStatus;
};

/** Dependencies the readiness probe verifies. Add new ones here. */
const DEPENDENCIES: Readonly<Record<keyof ReadinessChecks, () => Promise<void>>> = {
  db: pingDb,
  redis: pingRedis,
};

/**
 * Rejects if `promise` has not settled within `ms`. The timer is always
 * cleared, and unref'd so a pending probe never holds the process open
 * during shutdown.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one dependency check. Never throws — failure is reported as 'down'. */
async function checkDependency(
  name: keyof ReadinessChecks,
  probe: () => Promise<void>,
): Promise<DependencyStatus> {
  try {
    // Wrap in an async thunk so a synchronous throw inside `probe` is caught too.
    await withTimeout((async () => probe())(), READINESS_CHECK_TIMEOUT_MS, name);
    return 'ok';
  } catch (err) {
    logger.warn({ err, dependency: name }, 'readiness check failed');
    return 'down';
  }
}

/** Runs every dependency check in parallel. Exported for unit tests. */
export async function runReadinessChecks(): Promise<ReadinessChecks> {
  const entries = Object.entries(DEPENDENCIES) as [keyof ReadinessChecks, () => Promise<void>][];
  const results = await Promise.all(entries.map(([name, probe]) => checkDependency(name, probe)));
  return Object.fromEntries(entries.map(([name], i) => [name, results[i]])) as ReadinessChecks;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/** GET /health — 200 if process is up. */
export const liveness: RequestHandler = (_req, res) => {
  noStore(res);
  ok(res, { status: 'live', time: nowIso() });
};

/** GET /ready — 200 if MySQL and Redis are both usable, 503 otherwise. */
export const readiness: RequestHandler = async (req, res) => {
  const checks = await runReadinessChecks();
  const ready = Object.values(checks).every(s => s === 'ok');

  noStore(res);

  if (ready) {
    ok(res, { status: 'ready', ...checks, time: nowIso() });
    return;
  }

  // Each failing dependency was already logged with its error in
  // checkDependency(); this line is the single per-request summary.
  logger.warn({ checks }, 'readiness probe: not ready');

  const body: ErrorEnvelope = {
    error: {
      code: 'NOT_READY',
      message: 'Service not ready.',
      requestId: String(req.id),
      details: checks,
    },
  };
  res.status(503).json(body);
};

/* ==============================================================================
 * Root-level endpoints for browsers, bots and scanners
 * ==============================================================================
 * The API is consumed only by the mobile apps, which never call these. They
 * exist so that a human opening the base URL sees "this is an API and it is
 * up" instead of an error, and so that the requests every browser / crawler
 * makes automatically do not pollute the logs with 404 warnings.
 *
 * SECURITY: the root banner must stay minimal. Never add app version, git
 * SHA, NODE_ENV, runtime versions, route lists or dependency status here —
 * that is free fingerprinting for attackers. Dependency status lives on
 * /ready; build info, if ever needed, belongs behind authentication.
 * ============================================================================== */

/** Public service identifier. Matches the PM2 app name in ecosystem.config.cjs. */
const SERVICE_NAME = 'urbancruise-api';

/** Robots policy: an API has nothing to index. */
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** How long browsers / crawlers may cache the static root assets. */
const STATIC_ASSET_MAX_AGE_SECONDS = 24 * 60 * 60; // 1 day

/** GET / (and HEAD /, which Express derives from GET) — minimal service banner. */
export const root: RequestHandler = (_req, res) => {
  noStore(res);
  ok(res, { service: SERVICE_NAME, status: 'ok' });
};

/**
 * GET /favicon.ico — 204 No Content.
 * Browsers request this automatically on every visit; without a handler each
 * one becomes a ROUTE_NOT_FOUND warning in the logs. Cached so the browser
 * stops asking.
 */
export const favicon: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', `public, max-age=${STATIC_ASSET_MAX_AGE_SECONDS}`);
  res.status(204).end();
};

/** GET /robots.txt — tell well-behaved crawlers not to index the API. */
export const robots: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', `public, max-age=${STATIC_ASSET_MAX_AGE_SECONDS}`);
  res.type('text/plain').send(ROBOTS_TXT);
};
