/**
 * ==============================================================================
 * Pino logger — the ONE logger the app uses
 * ==============================================================================
 * JSON to stdout in prod (fast, structured, ship-anywhere). `pino-pretty` is
 * used ONLY when NODE_ENV=development — on prod it's ~30× slower and formats
 * on the main thread. Never enable it in prod.
 *
 * `child({ requestId })` produces a sub-logger where every subsequent line
 * carries the same requestId — that's how correlation works throughout the
 * request lifecycle. The pino-http middleware sets this up automatically.
 * ==============================================================================
 */
import pino, { type Logger } from 'pino';
import { ENV } from '../../config/env.js';
import { REDACT_PATHS } from './redactPaths.js';

const transport = ENV.isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    }
  : undefined;

export const logger: Logger = pino({
  level: ENV.LOG_LEVEL,
  base: { service: 'urbancruise-api', env: ENV.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
    remove: false,
  },
  formatters: {
    // OTel-friendly level names — 'level' becomes a string, not a number.
    level: label => ({ level: label }),
  },
  ...(transport ? { transport } : {}),
});

export type { Logger };
