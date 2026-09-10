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
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';

/* ==============================================================================
 * OTP / auth constants — tune here, not scattered across the auth module.
 * ============================================================================== */

/** OTP code length (digits). Change only if MSG91 template also changes. */
export const OTP_LENGTH = 6;

/** How long a sent OTP is valid, in seconds. Redis TTL matches. */
export const OTP_SESSION_TTL_SECONDS = 10 * 60; // 10 min

/** Client-facing "you may resend after N seconds" throttle. Enforced by
 *  Redis cooldown too — client just uses this to render the countdown. */
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

/** Idempotency snapshot lifetime — response for /auth/otp/request is
 *  replayable for 24h via the Idempotency-Key header. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Verify-fail counter TTL (per mobile). Hitting VERIFY_FAIL_LOCK_THRESHOLD
 *  within this window locks the number for VERIFY_LOCK_DURATION_SECONDS. */
export const VERIFY_FAIL_WINDOW_SECONDS = 15 * 60; // 15 min
export const VERIFY_FAIL_LOCK_THRESHOLD = 5;
export const VERIFY_LOCK_DURATION_SECONDS = 15 * 60; // 15 min

/* ==============================================================================
 * OTP send rate limits (per mobile). Enforced in Redis before hitting MSG91.
 * ============================================================================== */

/** Max OTP sends per mobile per 10 minutes. 3*/
export const OTP_SEND_MAX_PER_10M = 30;
/** Max OTP sends per mobile per day. 10*/
export const OTP_SEND_MAX_PER_DAY = 100;
/** Hard cooldown between two consecutive sends to the same mobile. */
export const OTP_SEND_MIN_INTERVAL_SECONDS = 30;

/* ==============================================================================
 * Refresh-session cache
 * ============================================================================== */

/** In-memory cache for auth_sessions row lookups. Disabled at MVP. */
export const SESSION_CACHE_TTL_SECONDS = 0;
