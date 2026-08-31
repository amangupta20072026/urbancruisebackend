/**
 * ==============================================================================
 * Express Request augmentation
 * ==============================================================================
 * Adds:
 *   req.identity — populated by authenticate middleware for protected routes
 *
 * `req.id` is NOT declared here — pino-http already declares it (as
 * `string | number | object`). We treat it as a string throughout the app
 * because our requestId middleware and pino-http's `genReqId` both return a
 * string. Callers use `String(req.id)` at the emit boundary to keep TS happy.
 *
 * Note: `req.identity` is optional. Routes behind `authenticate` are typed as
 * having it after the middleware runs. Controllers should call
 * `getIdentity(req)` from responses.ts to assert its presence at runtime.
 * ==============================================================================
 */
import type { Identity } from './identity.js';

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export {};
