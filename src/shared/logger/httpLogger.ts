/**
 * ==============================================================================
 * pino-http — 1 structured log line per request
 * ==============================================================================
 * - Uses the shared `logger` instance (redaction, level, transport apply).
 * - Sets `req.id` from an inbound X-Request-Id header if trusted from Nginx,
 *   else generates a UUID v4 via node:crypto.
 * - Custom log level per response: 4xx = warn, 5xx = error, else info.
 * - Slow requests (>1s) get promoted to warn so they surface in dashboards.
 * - Logs BOTH the client IP (`ip`, via trust proxy) and the socket peer
 *   (`remoteAddress`, i.e. Nginx) — finding L5.
 * ==============================================================================
 */
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request } from 'express';
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
        // L5: `ip` is the real client, resolved by Express from
        // X-Forwarded-For using `trust proxy` (TRUST_PROXY_HOPS). It must be
        // read from `req.raw`: pino-http hands this serializer a wrapped copy
        // whose own `.ip` is always undefined. `raw` is the Express request
        // because this logger is mounted as Express middleware (app.ts).
        ip: (req.raw as Request).ip,
        // Socket peer — the proxy (Nginx) in production. Kept for diagnosing
        // proxy-chain / TRUST_PROXY_HOPS problems: if `ip` ever equals this
        // on proxied traffic, the hop count or Nginx's XFF header is wrong.
        remoteAddress: req.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
