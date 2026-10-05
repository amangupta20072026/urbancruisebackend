/**
 * ==============================================================================
 * Rate limiting — Redis-backed, shared across every PM2 worker
 * ==============================================================================
 * WHY REDIS (security fix — audit item #5):
 *   express-rate-limit's default store is an in-process Map. PM2 runs
 *   `instances: 'max'` (one worker per CPU core), so every client got one
 *   bucket PER WORKER — on an 8-core box the "20 requests / 15 min" OTP
 *   limit was really 160. All limiters now share one counter in Redis, so
 *   the configured number is the real number no matter how many workers run.
 *
 * EVERY limiter in the app must be created through `createRateLimiter()` so
 * it gets the Redis store, the shared 429 envelope, and a unique key prefix.
 * Never call `rateLimit()` from express-rate-limit directly.
 *
 * FAILURE MODE — fail OPEN (`passOnStoreError: true`):
 *   If Redis is unreachable the request is allowed through and an error is
 *   logged with `alarm: 'rate_limit_store_down'` (alert on it). Deliberate:
 *   these limiters are a coarse outer guard. The OTP endpoints have their own
 *   strict Redis-backed limits inside the auth service (rate-limits.ts), and
 *   those fail CLOSED — without Redis no OTP can be stored or sent at all.
 *   Failing open here therefore never opens an SMS-cost hole; failing closed
 *   would only turn a Redis blip into a full API outage.
 * ==============================================================================
 */
import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitRequestHandler,
} from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Request } from 'express';
import { ENV } from '../../../config/env.js';
import { RateLimitError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import { redis } from '../../redis/client.js';
import { rateLimitPrefix } from '../../redis/keys.js';

/* ==============================================================================
 * Self-healing Redis store
 * ==============================================================================
 * rate-limit-redis loads two Lua scripts in init() and CACHES the resulting
 * promises. If Redis is briefly unreachable at boot (common during deploys
 * and restarts), those cached promises stay REJECTED forever — the library
 * only reloads on a NOSCRIPT error — so every request after recovery would
 * still fail and the limiter would be dead until the next process restart.
 *
 * This subclass marks a failed load as stale and reloads it on the next
 * request, so the limiter recovers by itself as soon as Redis is back.
 * ============================================================================== */
class SelfHealingRedisStore extends RedisStore {
  private incrementScriptStale = false;
  private getScriptStale = false;

  override loadIncrementScript(key?: string): Promise<string> {
    const p = super.loadIncrementScript(key);
    // Handled here, so a failed load can never become an unhandled
    // rejection (server.ts treats those as fatal).
    p.catch(() => {
      this.incrementScriptStale = true;
    });
    return p;
  }

  override loadGetScript(key?: string): Promise<string> {
    const p = super.loadGetScript(key);
    p.catch(() => {
      this.getScriptStale = true;
    });
    return p;
  }

  override retryableIncrement(key: string): Promise<RedisReply> {
    if (this.incrementScriptStale) {
      this.incrementScriptStale = false;
      this.incrementScriptSha = this.loadIncrementScript();
    }
    return super.retryableIncrement(key);
  }

  override get(key: string): ReturnType<RedisStore['get']> {
    if (this.getScriptStale) {
      this.getScriptStale = false;
      this.getScriptSha = this.loadGetScript();
    }
    return super.get(key);
  }
}

function createStore(name: string): RedisStore {
  return new SelfHealingRedisStore({
    // ioredis `call` sends an arbitrary command and resolves with the reply.
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
    prefix: rateLimitPrefix(name),
  });
}

/** Route express-rate-limit's own diagnostics into pino (default is console). */
const limiterLogger: Options['logger'] = {
  error: (err, message) =>
    logger.error({ err, alarm: 'rate_limit_store_down' }, message ?? 'rate limiter error'),
  warn: (err, message) => logger.warn({ err }, message ?? 'rate limiter warning'),
};

/* ==============================================================================
 * Factory
 * ============================================================================== */

export type RateLimiterOptions = {
  /** Unique, stable name — becomes the Redis key prefix. Two limiters must
   *  NEVER share a name, or they would share (and double-count) buckets. */
  name: string;
  windowMs: number;
  limit: number;
  /** Message in the 429 envelope. The `code` is always RATE_LIMITED. */
  message?: string;
  /** Custom bucket key. Defaults to the client IP (IPv6 normalised to /64). */
  keyGenerator?: (req: Request) => string;
};

const registeredNames = new Set<string>();

export function createRateLimiter(o: RateLimiterOptions): RateLimitRequestHandler {
  if (registeredNames.has(o.name)) {
    // Fail at boot rather than silently sharing buckets between limiters.
    throw new Error(`rate limiter name "${o.name}" is already in use`);
  }
  registeredNames.add(o.name);

  const handler: Options['handler'] = (req, _res, next, options) => {
    // resetTime comes from the store — turn it into a Retry-After hint.
    const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
    const retryAfter = resetTime
      ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
      : Math.ceil(options.windowMs / 1000);
    next(new RateLimitError(o.message, 'RATE_LIMITED', { retryAfter }));
  };

  return rateLimit({
    windowMs: o.windowMs,
    limit: o.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: createStore(o.name),
    passOnStoreError: true,
    logger: limiterLogger,
    keyGenerator: o.keyGenerator ?? (req => ipKeyGenerator(req.ip ?? '')),
    handler,
  });
}

/* ==============================================================================
 * Shared limiters
 * ============================================================================== */

/** Global limiter — mounted once in app.ts in front of every module. */
export const globalRateLimit = createRateLimiter({
  name: 'global',
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  limit: ENV.RATE_LIMIT_MAX,
});
