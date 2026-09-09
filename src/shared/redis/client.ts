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

redis.on('connect', () => logger.info('redis connected'));
redis.on('ready', () => logger.info('redis ready'));
redis.on('error', err => logger.error({ err }, 'redis error'));
redis.on('close', () => logger.warn('redis connection closed'));
redis.on('reconnecting', (delay: number) => logger.warn({ delay }, 'redis reconnecting'));
redis.on('end', () => logger.warn('redis connection ended'));

/** PING — used by /ready to prove Redis is reachable. */
export async function pingRedis(): Promise<void> {
  const r = await redis.ping();
  if (r !== 'PONG') {
    throw new Error(`redis ping returned unexpected value: ${r}`);
  }
}

/** Graceful shutdown — QUIT waits for in-flight commands, DISCONNECT drops them. */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
    logger.info('redis client closed');
  } catch (err) {
    logger.error({ err }, 'error while closing redis client');
  }
}
