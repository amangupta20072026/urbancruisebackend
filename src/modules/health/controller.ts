/**
 * Health probes and root-level endpoints.
 *
 * /health (liveness): the process responds; no dependency checks.
 * /ready (readiness): MySQL and Redis both reachable, else 503. Redis counts
 * because auth, rate limiting and the OTP flow all depend on it.
 * Checks run in parallel with a timeout each. Responses show only 'ok' or
 * 'down' per dependency; error details go to the logs. Never cached.
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

/** Rejects after `ms`. The timer is unref'd so it never delays shutdown. */
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
    // Async wrapper so a synchronous throw is caught too.
    await withTimeout((async () => probe())(), READINESS_CHECK_TIMEOUT_MS, name);
    return 'ok';
  } catch (err) {
    logger.warn({ err, dependency: name }, 'readiness check failed');
    return 'down';
  }
}

/** Runs all dependency checks in parallel. Exported for tests. */
export async function runReadinessChecks(): Promise<ReadinessChecks> {
  const entries = Object.entries(DEPENDENCIES) as [keyof ReadinessChecks, () => Promise<void>][];
  const results = await Promise.all(entries.map(([name, probe]) => checkDependency(name, probe)));
  return Object.fromEntries(entries.map(([name], i) => [name, results[i]])) as ReadinessChecks;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/** GET /health — 200 while the process is up. */
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

  // Individual failures were logged in checkDependency(); this is the summary.
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

/*
 * Root-level endpoints for browsers and crawlers, so they don't fill the
 * logs with 404s. Keep the banner minimal: no versions, env, routes or
 * dependency status (it helps attackers fingerprint the server).
 */

/** Matches the PM2 app name in ecosystem.config.cjs. */
const SERVICE_NAME = 'urbancruise-api';

/** Nothing to index. */
const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** Cache lifetime for favicon and robots.txt. */
const STATIC_ASSET_MAX_AGE_SECONDS = 24 * 60 * 60; // 1 day

/** GET / — minimal service banner. */
export const root: RequestHandler = (_req, res) => {
  noStore(res);
  ok(res, { service: SERVICE_NAME, status: 'ok' });
};

/** GET /favicon.ico — 204, cached so browsers stop asking. */
export const favicon: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', `public, max-age=${STATIC_ASSET_MAX_AGE_SECONDS}`);
  res.status(204).end();
};

/** GET /robots.txt — disallow all. */
export const robots: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', `public, max-age=${STATIC_ASSET_MAX_AGE_SECONDS}`);
  res.type('text/plain').send(ROBOTS_TXT);
};
