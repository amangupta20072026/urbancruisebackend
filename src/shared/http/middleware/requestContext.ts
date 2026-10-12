/**
 * Per-request context (request id and identity) via AsyncLocalStorage, so
 * deeper code can read it without passing it through every function.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { Identity } from '../../types/identity.js';

type RequestContext = {
  requestId: string;
  identity?: Identity;
};

const store = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}

// Must run after requestId.
export const requestContext: RequestHandler = (req, _res, next) => {
  const ctx: RequestContext = { requestId: String(req.id) };
  store.run(ctx, () => {
    // A getter, because authenticate sets req.identity later in the request.
    Object.defineProperty(ctx, 'identity', {
      configurable: false,
      enumerable: true,
      get: () => req.identity,
    });
    next();
  });
};
