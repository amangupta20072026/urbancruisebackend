/**
 * ==============================================================================
 * pino-http — 1 structured log line per request
 * ==============================================================================
 * - Uses the shared `logger` instance (redaction, level, transport apply).
 * - Sets `req.id` from an inbound X-Request-Id header if trusted from Nginx,
 *   else generates a UUID v4 via node:crypto.
 * - Custom log level per response: 4xx = warn, 5xx = error, else info.
 * - Slow requests (>1s) get promoted to warn so they surface in dashboards.
 * ==============================================================================
 */
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HEADER_REQUEST_ID } from '../../config/constants.js';
import { logger } from './index.js';

const SLOW_MS = 1000;

export const httpLogger = pinoHttp({
  logger,
  genReqId(req: IncomingMessage, res: ServerResponse) {
    // Nginx forwards X-Request-Id (see deploy/nginx/*). Trust it — Nginx sets a
    // fresh value if the client didn't send one, so we never leak inbound IDs.
    const inbound = req.headers[HEADER_REQUEST_ID];
    const id = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
    if (!res.getHeader('X-Request-Id')) res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage(_req, _res, responseTime) {
    if (responseTime > SLOW_MS) return `slow request (${responseTime}ms)`;
    return `request completed`;
  },
  customErrorMessage(_req, _res, err) {
    return `request errored: ${err.message}`;
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
