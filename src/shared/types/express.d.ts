/**
 * Adds req.identity (set by authenticate). req.id is already typed by
 * pino-http; the app always sets it to a string.
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
