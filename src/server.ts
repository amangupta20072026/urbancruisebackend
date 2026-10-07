/**
 * ==============================================================================
 * createServer — HTTP server + graceful shutdown
 * ==============================================================================
 * Contract with PM2 (see ecosystem.config.cjs):
 *   - After listen() succeeds we send 'ready' so PM2 knows the worker can
 *     accept traffic (`wait_ready: true`).
 *   - On SIGINT/SIGTERM we stop accepting new connections, wait for in-flight
 *     requests to finish (up to SHUTDOWN_TIMEOUT_MS), close the MySQL pool
 *     and the Redis client in parallel, then exit 0. If the grace window
 *     elapses, we force-exit 1 so PM2 can restart the worker.
 *
 * ORDER MATTERS: Redis and MySQL are closed only AFTER the HTTP drain.
 * In-flight requests still use Redis (JWT denylist, rate limiters, OTP
 * state) and MySQL; closing either earlier would fail requests that were
 * accepted before the signal arrived. They close in parallel and neither
 * close function throws, so one failing dependency cannot skip the other.
 * closeRedis() is bounded by REDIS_QUIT_TIMEOUT_MS; the force-exit timer
 * above caps everything else (including a hung pool.end()).
 *
 * HTTP TIMEOUTS (finding L2): Node's defaults let one request take 5 min
 * to arrive and drop idle keep-alive connections after 5 s. We set:
 *   requestTimeout   — HTTP_REQUEST_TIMEOUT_MS   (receive whole request)
 *   headersTimeout   — HTTP_HEADERS_TIMEOUT_MS   (receive headers)
 *   keepAliveTimeout — HTTP_KEEP_ALIVE_TIMEOUT_MS (> Nginx upstream
 *                      keepalive_timeout, so Node never closes a socket
 *                      Nginx is about to reuse)
 * and pass connectionsCheckingInterval so those limits fire on time
 * (Node's default 30 s check interval delays them). requestTimeout does
 * NOT limit handler run time — a slow PDF render still completes.
 * Idle keep-alive sockets do not delay shutdown: server.close() drops them.
 *
 * DEADLINE vs PM2 (finding M8): PM2 sends SIGKILL `kill_timeout` ms after
 * its stop signal. That must be LATER than SHUTDOWN_TIMEOUT_MS, otherwise
 * PM2 kills the worker at the same moment our force-exit fires and the
 * final log lines are lost. PM2 exposes the value as
 * process.env.kill_timeout, so checkPm2KillTimeout() warns at boot
 * (`alarm: 'shutdown_deadline_misconfigured'`) when the gap is too small.
 *
 * Also traps unhandledRejection and uncaughtException — both are treated as
 * fatal (log + exit 1), and PM2 restarts.
 * ==============================================================================
 */
import http from 'node:http';
import type { Express } from 'express';
import { ENV } from './config/env.js';
import {
  HTTP_CONNECTIONS_CHECK_INTERVAL_MS,
  SHUTDOWN_KILL_MARGIN_MS,
  SHUTDOWN_TIMEOUT_MS,
} from './config/constants.js';
import { logger } from './shared/logger/index.js';
import { closePool } from './shared/db/pool.js';
import { closeRedis } from './shared/redis/client.js';

/**
 * Boot-time guard for M8. Only runs under PM2 (which sets
 * process.env.kill_timeout); plain `node`, `tsx` and tests skip it.
 * Logs and continues — a wrong deadline is worth an alarm, not an outage.
 */
function checkPm2KillTimeout(): void {
  const raw = process.env['kill_timeout'];
  if (raw === undefined) return;
  const killTimeoutMs = Number(raw);
  const minimumMs = SHUTDOWN_TIMEOUT_MS + SHUTDOWN_KILL_MARGIN_MS;
  if (!Number.isFinite(killTimeoutMs) || killTimeoutMs < minimumMs) {
    logger.error(
      {
        alarm: 'shutdown_deadline_misconfigured',
        pm2KillTimeoutMs: raw,
        shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
        minimumKillTimeoutMs: minimumMs,
      },
      'PM2 kill_timeout is not longer than the app shutdown deadline — PM2 may SIGKILL ' +
        'the worker mid-shutdown. Raise kill_timeout in ecosystem.config.cjs.',
    );
  }
}

export function createServer(app: Express): http.Server {
  checkPm2KillTimeout();
  const server = http.createServer(
    { connectionsCheckingInterval: HTTP_CONNECTIONS_CHECK_INTERVAL_MS },
    app,
  );
  server.requestTimeout = ENV.HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = ENV.HTTP_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = ENV.HTTP_KEEP_ALIVE_TIMEOUT_MS;

  server.listen(ENV.PORT, () => {
    logger.info(
      {
        port: ENV.PORT,
        env: ENV.NODE_ENV,
        requestTimeoutMs: server.requestTimeout,
        headersTimeoutMs: server.headersTimeout,
        keepAliveTimeoutMs: server.keepAliveTimeout,
      },
      'server listening',
    );
    // Signal PM2 we're ready (only relevant when spawned by PM2)
    process.send?.('ready');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    // Hard cap — force-exit if drain hangs
    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Stop accepting new connections; wait for in-flight to complete
    await new Promise<void>(resolve => {
      server.close(err => {
        if (err) logger.error({ err }, 'http server close error');
        resolve();
      });
    });

    // Only now that no request can still need them: close MySQL + Redis.
    await Promise.all([closePool(), closeRedis()]);

    logger.info('shutdown complete');
    clearTimeout(forceExit);
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  // These are BUGS. Log with full stack + exit; supervisor restarts.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  return server;
}
