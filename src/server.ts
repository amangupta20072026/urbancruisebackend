/**
 * ==============================================================================
 * createServer — HTTP server + graceful shutdown
 * ==============================================================================
 * Contract with PM2 (see ecosystem.config.cjs):
 *   - After listen() succeeds we send 'ready' so PM2 knows the worker can
 *     accept traffic (`wait_ready: true`).
 *   - On SIGINT/SIGTERM we stop accepting new connections, wait for in-flight
 *     requests to finish (up to SHUTDOWN_TIMEOUT_MS), close the DB pool, then
 *     exit 0. If the grace window elapses, we force-exit 1 so PM2 can restart
 *     the worker.
 *
 * Also traps unhandledRejection and uncaughtException — both are treated as
 * fatal (log + exit 1), and PM2 restarts.
 * ==============================================================================
 */
import http from 'node:http';
import type { Express } from 'express';
import { ENV } from './config/env.js';
import { SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { logger } from './shared/logger/index.js';
import { closePool } from './shared/db/pool.js';

export function createServer(app: Express): http.Server {
  const server = http.createServer(app);

  server.listen(ENV.PORT, () => {
    logger.info({ port: ENV.PORT, env: ENV.NODE_ENV }, 'server listening');
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

    // Close the DB pool
    await closePool();

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
