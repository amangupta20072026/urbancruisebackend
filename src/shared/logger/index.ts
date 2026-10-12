/**
 * The app's single pino logger: JSON to stdout, with secrets redacted.
 * Pretty output (pino-pretty) only in development.
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
    // Log the level as a name ("info"), not a number.
    level: label => ({ level: label }),
  },
  ...(transport ? { transport } : {}),
});

export type { Logger };
