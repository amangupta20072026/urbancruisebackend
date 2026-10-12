/**
 * Fixed, non-secret application constants. Values that differ per
 * environment or are secret belong in env.ts instead.
 */

// Body size limits for all routes except webhooks. A route that ever needs
// file uploads must use its own parser and limit.
export const JSON_BODY_LIMIT = '100kb';
export const URLENCODED_BODY_LIMIT = '100kb';

// Webhooks only: MSG91 delivery reports arrive in large batches.
export const WEBHOOK_BODY_LIMIT = '1mb';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// How often Node enforces the HTTP request/headers timeouts. Node's default
// (30 s) makes those timeouts fire up to 30 s late.
export const HTTP_CONNECTIONS_CHECK_INTERVAL_MS = 1_000;

// IPv6 prefix used to group clients in the HTTP rate limiters. Mobile
// networks give each device its own /64, so /64 ≈ one device. Set explicitly
// so a library default change cannot alter grouping. Keep equal to the /64
// in shared/utils/ip-bucket.ts.
export const IPV6_RATE_LIMIT_SUBNET = 64;

// Graceful shutdown deadline before force-exit. PM2's kill_timeout in
// ecosystem.config.cjs must be at least this + SHUTDOWN_KILL_MARGIN_MS.
export const SHUTDOWN_TIMEOUT_MS = 15_000;

// Extra time PM2 must allow so the force-exit can still log before SIGKILL.
export const SHUTDOWN_KILL_MARGIN_MS = 2_000;

// Per-dependency timeout for the /ready probe. Keep below the load
// balancer's probe timeout so we answer 503 instead of timing out.
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_AUTHORIZATION = 'authorization';
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';

/* ---------- OTP / auth ---------- */

// Must match the MSG91 SMS template.
export const OTP_LENGTH = 6;

export const OTP_SESSION_TTL_SECONDS = 10 * 60;

// Sent to the client for its resend countdown. The server-side cooldown is
// OTP_SEND_MIN_INTERVAL_SECONDS.
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

// How long an /auth/otp/request response can be replayed via Idempotency-Key.
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// This many wrong codes for one mobile within the window locks the number
// for VERIFY_LOCK_DURATION_SECONDS.
export const VERIFY_FAIL_WINDOW_SECONDS = 15 * 60;
export const VERIFY_FAIL_LOCK_THRESHOLD = 5;

// Max verify attempts per OTP, counted before the code is compared, so
// parallel guesses cannot exceed it.
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
export const VERIFY_LOCK_DURATION_SECONDS = 15 * 60;

/* ---------- Customer onboarding ---------- */

// Time a new customer has to finish onboarding after verifying the OTP.
export const ONBOARDING_TICKET_TTL_SECONDS = 30 * 60;

// Wait limit for the per-mobile MySQL lock that prevents duplicate customers.
export const CUSTOMER_CREATE_LOCK_TIMEOUT_SECONDS = 5;

/* ---------- Account status ---------- */

// Status values (trimmed, case-insensitive) that allow login. Anything else
// is treated as inactive. Applies to uc_staff and vendors; customers and
// drivers have no status column.
export const ACTIVE_STATUS_VALUES: ReadonlySet<string> = new Set(['active']);

// Treat NULL/empty vendor status (legacy rows) as active.
export const VENDOR_NULL_STATUS_IS_ACTIVE = true;

/* ---------- OTP send limits (per mobile) ---------- */

// Production values. For local testing, add the number to MSG91_TEST_MOBILES
// instead of raising these.
export const OTP_SEND_MAX_PER_10M = 3;
export const OTP_SEND_MAX_PER_DAY = 10;
export const OTP_SEND_MIN_INTERVAL_SECONDS = 30;

/* ---------- SMS-pumping defense (number prefix) ---------- */
// Per-IP-block caps are in env.ts (OTP_IPV4_* / OTP_IPV6_*).
// Test mobiles skip these limits.

export const OTP_SEND_MAX_PER_PREFIX_PER_HOUR = 500;

// Leading characters of the mobile (with country code) used as the prefix,
// e.g. "91981".
export const OTP_PREFIX_LENGTH = 5;

/* ---------- MSG91 retry and circuit breaker ---------- */

// Retries only transient failures (network, timeout, 5xx). The retry sends
// the same OTP, so a duplicate SMS is harmless.
export const MSG91_MAX_RETRIES = 1;
export const MSG91_RETRY_DELAY_MS = 500;

// After this many failed sends in a row (within the window; a success resets
// the count), stop calling MSG91 for MSG91_CB_OPEN_SECONDS and return 503.
export const MSG91_CB_FAILURE_THRESHOLD = 5;
export const MSG91_CB_WINDOW_SECONDS = 300;
export const MSG91_CB_OPEN_SECONDS = 60;

/* ---------- Refresh token reuse ---------- */

// A refresh token reused within this many seconds of its own rotation (with
// the new session still active) is treated as a duplicate request from the
// app, not theft. Keep short: replay goes unnoticed inside this window.
export const REFRESH_REUSE_GRACE_SECONDS = 10;
