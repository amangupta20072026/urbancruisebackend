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
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HEADER_REQUEST_ID } from '../../config/constants.js';
import { logger } from './index.js';
import { redactUrl } from './redactUrl.js';
import { resolveRequestId } from '../utils/request-id.js';

const SLOW_MS = 1000;

export const httpLogger = pinoHttp({
  logger,
  genReqId(req: IncomingMessage, res: ServerResponse) {
    // Fallback only: the requestId middleware runs first and pino-http reuses
    // its req.id. Same validation either way (audit fix #16) — an inbound id
    // is never trusted verbatim, even when it "came from" Nginx, because a
    // client can send the header straight through a proxy that forwards it.
    const id = resolveRequestId(req.headers[HEADER_REQUEST_ID]);
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
        // Never log raw: some paths carry secrets (see redactUrl.ts).
        url: redactUrl(req.url),
        remoteAddress: req.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
