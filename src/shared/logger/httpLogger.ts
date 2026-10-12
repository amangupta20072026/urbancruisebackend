/**
 * One access-log line per request. Level: 5xx/error → error, 4xx → warn,
 * else info. Requests over SLOW_MS are labelled "slow request".
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
    // Fallback only: the requestId middleware normally sets req.id first.
    // Inbound ids are validated, never trusted as is.
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
        // Some paths contain secrets (see redactUrl.ts).
        url: redactUrl(req.url),
        // Client IP via trust proxy. Read from req.raw: the serialized req
        // passed here has no .ip of its own.
        ip: (req.raw as Request).ip,
        // Direct peer (Nginx in production). If it equals ip on proxied
        // traffic, TRUST_PROXY_HOPS or the X-Forwarded-For setup is wrong.
        remoteAddress: req.remoteAddress,
        userAgent: req.headers?.['user-agent'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
