/**
 * ==============================================================================
 * Non-secret application constants
 * ==============================================================================
 * Anything a security auditor should NOT see in .env goes here. If a value
 * changes per environment it belongs in env.ts. If it never changes, it
 * belongs here.
 * ==============================================================================
 */

export const JSON_BODY_LIMIT = '10mb';
export const URLENCODED_BODY_LIMIT = '10mb';

/** Default pagination page size when the caller doesn't specify one. */
export const DEFAULT_PAGE_SIZE = 20;
/** Max page size we'll honor even if the caller asks for more. */
export const MAX_PAGE_SIZE = 100;

/** Request timeout — belt to Nginx's braces. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** How long the graceful shutdown drain has before we hard-exit. */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Header names — centralize spelling so no one typoes 'X-Request-ID' vs 'X-Request-Id'. */
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_AUTHORIZATION = 'authorization';
