/**
 * The shared Redis client (ioredis). It reconnects automatically and queues
 * commands while reconnecting.
 * BullMQ (in package.json, not used yet) must get its own connection: its
 * blocking commands would stall this client.
 */
import { Redis, type Redis as RedisClient } from 'ioredis';
import { ENV } from '../../config/env.js';
import { logger } from '../logger/index.js';

export const redis: RedisClient = new Redis({
  host: ENV.REDIS_HOST,
  port: ENV.REDIS_PORT,
  password: ENV.REDIS_PASSWORD,

  // Reconnect delay grows 200 ms per attempt, capped at 5 s.
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  maxRetriesPerRequest: 3,

  // TCP keep-alive so idle connections aren't dropped by the network.
  keepAlive: 30_000,

  connectTimeout: 10_000,

  // Connect at startup so connection problems show up immediately.
  lazyConnect: false,
});

// True during shutdown, so an expected close logs as info, not warn.
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
 * Health check for /ready. Fails at once if the client isn't 'ready'
 * (otherwise PING would wait in the offline queue). Callers should still
 * add a timeout: a dead connection can look 'ready'.
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

/** Max wait for QUIT on shutdown. Keep well below SHUTDOWN_TIMEOUT_MS. */
export const REDIS_QUIT_TIMEOUT_MS = 3_000;

/**
 * Closes Redis on shutdown. Never throws. Uses QUIT when connected (falls
 * back to disconnect on error or timeout), otherwise disconnects at once.
 * Call only after the HTTP server has drained.
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
