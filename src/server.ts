/**
 * Starts the HTTP server and handles graceful shutdown.
 *
 * Shutdown: stop accepting connections, let in-flight requests finish, then
 * close MySQL and Redis (in-flight requests still need them). If this takes
 * longer than SHUTDOWN_TIMEOUT_MS, the process force-exits with code 1.
 *
 * Timeouts: requestTimeout/headersTimeout limit how long a client may take to
 * SEND a request (not how long a handler runs). keepAliveTimeout must stay
 * above Nginx's upstream keepalive_timeout to avoid 502s.
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
 * Warns if PM2's kill_timeout is too short for our shutdown deadline, since
 * PM2 would SIGKILL the worker mid-shutdown. Runs only under PM2.
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
  // Short check interval so the timeouts below fire on time.
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
    // Tells PM2 (wait_ready) this worker can take traffic. No-op outside PM2.
    process.send?.('ready');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    await new Promise<void>(resolve => {
      server.close(err => {
        if (err) logger.error({ err }, 'http server close error');
        resolve();
      });
    });

    // Close only after the drain; neither function throws.
    await Promise.all([closePool(), closeRedis()]);

    logger.info('shutdown complete');
    clearTimeout(forceExit);
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  // Treated as fatal bugs: log, shut down, and let PM2 restart the worker.
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
