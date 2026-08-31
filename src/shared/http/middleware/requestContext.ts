/**
 * ==============================================================================
 * requestContext — AsyncLocalStorage store per request
 * ==============================================================================
 * Lets any downstream code — service, repository, logger — read `req.id` and
 * `identity` WITHOUT threading them through every function signature.
 *
 * Usage:
 *     import { getRequestContext } from '.../requestContext.js';
 *     const ctx = getRequestContext();
 *     logger.info({ userId: ctx?.identity?.userId }, '...');
 *
 * NEVER mutate the store from downstream code — it's per-request read-only.
 * ==============================================================================
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

/**
 * Sets req.id into the store. Runs AFTER requestId middleware. Later, when
 * authenticate populates req.identity, that value is picked up on the next
 * async tick — same store, mutated in place for the whole request.
 */
export const requestContext: RequestHandler = (req, _res, next) => {
  const ctx: RequestContext = { requestId: String(req.id) };
  store.run(ctx, () => {
    // Re-mount identity into the ctx once authenticate has populated it. We
    // read from req.identity dynamically since it's set later in the pipeline.
    Object.defineProperty(ctx, 'identity', {
      configurable: false,
      enumerable: true,
      get: () => req.identity,
    });
    next();
  });
};
