/**
 * Redis-backed rate limiting, shared by all PM2 workers (an in-memory store
 * would give each worker its own counter). Create every limiter with
 * createRateLimiter().
 *
 * Fails open: if Redis is down, requests pass and 'rate_limit_store_down' is
 * logged. The OTP flow cannot run without Redis, so this opens no SMS-cost gap.
 */
import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitRequestHandler,
} from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Request } from 'express';
import { ENV } from '../../../config/env.js';
import { IPV6_RATE_LIMIT_SUBNET } from '../../../config/constants.js';
import { RateLimitError } from '../../errors/index.js';
import { logger } from '../../logger/index.js';
import { redis } from '../../redis/client.js';
import { rateLimitPrefix } from '../../redis/keys.js';

/**
 * rate-limit-redis caches its Lua script loads; if Redis is down at startup
 * the cached load stays failed forever. This subclass retries the load on
 * the next request so the limiter recovers once Redis is back.
 */
class SelfHealingRedisStore extends RedisStore {
  private incrementScriptStale = false;
  private getScriptStale = false;

  override loadIncrementScript(key?: string): Promise<string> {
    const p = super.loadIncrementScript(key);
    // Catch so a failed load is never an unhandled rejection (fatal in server.ts).
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

/** Creates a new RedisStore with the given prefix. Each limiter must have a unique name so its counters don't collide. */
function createStore(name: string): RedisStore {
  return new SelfHealingRedisStore({
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
    prefix: rateLimitPrefix(name),
  });
}

/** express-rate-limit setup mistakes use ERR_ERL_* codes (not Redis failures). */
function isLimiterConfigError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_ERL_');
}

/**
 * Sends the library's logs to pino, with separate alarms for a wrong limiter
 * setup (rate_limit_misconfigured) and a Redis failure (rate_limit_store_down).
 */
const limiterLogger: Options['logger'] = {
  error: (err, message) => {
    if (isLimiterConfigError(err)) {
      logger.error(
        { err, alarm: 'rate_limit_misconfigured' },
        message ?? 'rate limiter configuration error — fix the limiter options',
      );
      return;
    }
    logger.error({ err, alarm: 'rate_limit_store_down' }, message ?? 'rate limiter error');
  },
  warn: (err, message) => logger.warn({ err }, message ?? 'rate limiter warning'),
};

/**
 * Rate-limit key for the client IP: IPv4 as is, IPv6 grouped by
 * IPV6_RATE_LIMIT_SUBNET so rotating addresses can't bypass limits.
 * Use this in custom keyGenerators instead of req.ip.
 */
export function clientIpKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? '', IPV6_RATE_LIMIT_SUBNET);
}

export type RateLimiterOptions = {
  /** Unique name, used as the Redis key prefix. */
  name: string;
  windowMs: number;
  limit: number;
  /** 429 message. The code is always RATE_LIMITED. */
  message?: string;
  /** Bucket key. Defaults to clientIpKey(). */
  keyGenerator?: (req: Request) => string;
};

const registeredNames = new Set<string>();

/** Creates a new rate limiter with the given options. Each limiter must have a unique name so its counters don't collide. */
export function createRateLimiter(o: RateLimiterOptions): RateLimitRequestHandler {
  if (registeredNames.has(o.name)) {
    // Shared names would share counters, so fail at startup.
    throw new Error(`rate limiter name "${o.name}" is already in use`);
  }
  registeredNames.add(o.name);

  const handler: Options['handler'] = (req, _res, next, options) => {
    // Retry-After from the store's reset time, or the full window if unknown.
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
    keyGenerator: o.keyGenerator ?? clientIpKey,
    handler,
  });
}

/** Applied to all routes in app.ts. */
export const globalRateLimit = createRateLimiter({
  name: 'global',
  windowMs: ENV.RATE_LIMIT_WINDOW_MS,
  limit: ENV.RATE_LIMIT_MAX,
});
