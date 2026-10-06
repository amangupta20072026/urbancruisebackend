/**
 * ==============================================================================
 * Redis client — singleton
 * ==============================================================================
 * ioredis instance created ONCE at module load. Import `redis` anywhere.
 *
 * WHY IOREDIS (not node-redis): auto-reconnect, offline queue, cluster-ready
 * out of the box. Our OTP hot path cannot tolerate a "sorry, disconnected"
 * — ioredis buffers commands during reconnect and flushes them.
 *
 * Two clients might be needed later (pub/sub uses a dedicated connection),
 * but the OTP + session + idempotency workload is all request/response,
 * so ONE connection is enough for MVP.
 *
 * BullMQ (installed but not yet wired) will need its own connection object;
 * pass a factory `() => new Redis(opts)` when you set that up — do NOT share
 * this client, BullMQ's blocking commands would starve the OTP path.
 * ==============================================================================
 */
import { Redis, type Redis as RedisClient } from 'ioredis';
import { ENV } from '../../config/env.js';
import { logger } from '../logger/index.js';

export const redis: RedisClient = new Redis({
  host: ENV.REDIS_HOST,
  port: ENV.REDIS_PORT,
  password: ENV.REDIS_PASSWORD,

  // Retry with exponential backoff up to 5s. The alternative (fail-fast)
  // would 500-out the OTP endpoint during a Redis restart.
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  maxRetriesPerRequest: 3,

  // Enable keep-alive at the TCP layer — same reason as MySQL pool: keeps
  // idle NAT/LB stickiness from dropping the connection.
  keepAlive: 30_000,

  // Fail early if the initial connect can't succeed within 10s.
  connectTimeout: 10_000,

  // Lazy-connect off — we want to fail loudly at boot if creds are wrong.
  lazyConnect: false,
});

/**
 * Set once closeRedis() starts. Lets the 'close' / 'end' listeners tell an
 * intentional shutdown (info) apart from an unexpected drop (warn), so every
 * deploy does not leave misleading warnings in the logs.
 */
let closing = false;

redis.on('connect', () => logger.info('redis connected'));
redis.on('ready', () => logger.info('redis ready'));
redis.on('error', err => logger.error({ err }, 'redis error'));
redis.on('close', () => {
  if (closing) logger.info('redis connection closed');
  else logger.warn('redis connection closed');
});
redis.on('reconnecting', (delay: number) => logger.warn({ delay }, 'redis reconnecting'));
redis.on('end', () => {
  if (closing) logger.info('redis connection ended');
  else logger.warn('redis connection ended');
});

/**
 * PING — used by /ready to prove Redis is reachable AND usable.
 *
 * Fails fast when the client is not in the 'ready' state (connecting,
 * reconnecting, closed, …). Without this guard the PING would sit in the
 * ioredis offline queue and be retried (maxRetriesPerRequest) across
 * reconnect attempts, so a probe against a dead Redis would hang for
 * seconds instead of reporting it down. Callers should still apply their
 * own timeout: a half-open TCP connection can look 'ready' and never reply.
 */
export async function pingRedis(): Promise<void> {
  if (redis.status !== 'ready') {
    throw new Error(`redis client not ready (status: ${redis.status})`);
  }
  const r = await redis.ping();
  if (r !== 'PONG') {
    throw new Error(`redis ping returned unexpected value: ${r}`);
  }
}

/**
 * Upper bound for a graceful QUIT during shutdown. Must stay well below
 * SHUTDOWN_TIMEOUT_MS (15s) so a slow Redis can never push the process into
 * the hard force-exit path.
 */
export const REDIS_QUIT_TIMEOUT_MS = 3_000;

/**
 * Graceful shutdown. Never throws, and always settles within
 * REDIS_QUIT_TIMEOUT_MS (+ a tick).
 *
 *   status 'end'     → already closed; nothing to do (idempotent).
 *   status 'ready'   → QUIT: Redis finishes in-flight commands, then closes.
 *                      If QUIT fails or exceeds the timeout → disconnect().
 *   any other status → disconnect() immediately. A QUIT issued while
 *                      connecting / reconnecting would sit in the offline
 *                      queue and stall shutdown until the force-exit fires.
 *
 * disconnect() drops the socket at once and cancels any pending reconnect,
 * so after this function returns the client holds no timers or sockets that
 * could keep the event loop alive.
 *
 * Call it only AFTER the HTTP server has drained: in-flight requests still
 * need Redis for the JWT denylist and the rate limiters.
 */
export async function closeRedis(timeoutMs: number = REDIS_QUIT_TIMEOUT_MS): Promise<void> {
  closing = true;

  if (redis.status === 'end') return;

  if (redis.status !== 'ready') {
    logger.warn({ status: redis.status }, 'redis not ready at shutdown; disconnecting immediately');
    redis.disconnect();
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redis QUIT timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    await Promise.race([redis.quit(), timeout]);
    logger.info('redis client closed');
  } catch (err) {
    logger.warn({ err }, 'redis QUIT failed; forcing disconnect');
    redis.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
