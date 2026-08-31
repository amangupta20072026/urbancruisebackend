/**
 * ==========================================================================
 * Non-secret application constants
 * --------------------------------------------------------------------------
 * Anything that could conceivably change per environment goes in ENV.
 * Anything that's a compile-time truth (defaults, limits) lives here.
 * ==========================================================================
 */

// --------------------------------------------------------------------------
// HTTP headers used across the app
// --------------------------------------------------------------------------
export const HEADER = {
  REQUEST_ID: 'x-request-id',
  FORWARDED_FOR: 'x-forwarded-for',
  FORWARDED_PROTO: 'x-forwarded-proto',
  AUTHORIZATION: 'authorization',
} as const;

// --------------------------------------------------------------------------
// Pagination defaults
// --------------------------------------------------------------------------
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

// --------------------------------------------------------------------------
// Body-size limits
// --------------------------------------------------------------------------
export const BODY_LIMIT = {
  JSON: '10mb',
  URLENCODED: '10mb',
} as const;

// --------------------------------------------------------------------------
// Timeouts
// --------------------------------------------------------------------------
export const SHUTDOWN = {
  // Time to wait for in-flight requests to finish before force-exiting.
  // Should be < PM2's kill_timeout (currently 15s) so PM2 doesn't SIGKILL
  // us mid-drain.
  GRACE_MS: 10_000,
} as const;