/**
 * ==============================================================================
 * Rate limiting — global + per-route factory
 * ==============================================================================
 * NOTE on PM2 cluster mode:
 *   express-rate-limit uses an in-process memory store by default. Under
 *   PM2 cluster (multiple workers per instance), a client gets N buckets —
 *   one per worker. When you move to prod with cluster mode, swap the store
 *   for `rate-limit-redis` + ioredis. Until then, this per-process cap is
 *   still useful as a coarse per-worker safety net.
 * ==============================================================================
 */
import rateLimit, { type Options } from 'express-rate-limit';
import { ENV } from '../../../config/env.js';
import { RateLimitError } from '../../errors/index.js';

/** 429 handler — throws AppError so the central errorHandler formats it. */
const rateLimitHandler: Options['handler'] = (_req, _res, next) => {
  next(new RateLimitError());
};

/** Global limiter — mounted early for all routes. */
export const globalRateLimit = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  limit: ENV.RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/** Tighter limiter for /auth/* — prevents credential-stuffing / OTP brute force. */
export const authRateLimit = rateLimit({
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  limit: ENV.RATE_LIMIT_AUTH_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/** Factory for custom per-route buckets. */
export function makeRateLimit(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: rateLimitHandler,
  });
}
