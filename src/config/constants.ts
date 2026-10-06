/**
 * ==============================================================================
 * Non-secret application constants
 * ==============================================================================
 * Anything a security auditor should NOT see in .env goes here. If a value
 * changes per environment it belongs in env.ts. If it never changes, it
 * belongs here.
 * ==============================================================================
 */

/**
 * Request body limits (audit fix #15). Were 10mb: every unauthenticated
 * endpoint would read and JSON-parse up to 10 MB per request — a cheap
 * CPU/memory amplifier for anyone. The largest legitimate body in this API
 * (an FCM token registration, ~4 KB) is far below 100 KB. There are no file
 * uploads; if one is added it must use its own route-level parser/limit.
 */
export const JSON_BODY_LIMIT = '100kb';
export const URLENCODED_BODY_LIMIT = '100kb';

/** Provider webhooks only (MSG91 DLR batches can carry hundreds of records). */
export const WEBHOOK_BODY_LIMIT = '1mb';

/** Default pagination page size when the caller doesn't specify one. */
export const DEFAULT_PAGE_SIZE = 20;
/** Max page size we'll honor even if the caller asks for more. */
export const MAX_PAGE_SIZE = 100;

/** Request timeout — belt to Nginx's braces. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** How long the graceful shutdown drain has before we hard-exit. */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

/**
 * Per-dependency budget for the /ready probe (MySQL ping, Redis ping).
 * Checks run in parallel, so the whole probe answers within roughly this
 * time even when a dependency hangs. Keep it well below the orchestrator /
 * load-balancer probe timeout so we always answer 503 ourselves rather than
 * letting the caller time out with no signal.
 */
export const READINESS_CHECK_TIMEOUT_MS = 2_000;

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

/** Max verify attempts against ONE OTP (one requestId), enforced atomically
 *  BEFORE the code is compared. This is the hard brute-force bound: however
 *  many guesses arrive in parallel, at most this many are ever evaluated per
 *  OTP. Combined with OTP_SEND_MAX_PER_DAY it caps guesses per number per
 *  day at 5 × 10 = 50 (≈ 1 in 20,000 odds for a 6-digit code). */
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
export const VERIFY_LOCK_DURATION_SECONDS = 15 * 60; // 15 min

/* ==============================================================================
 * Customer onboarding (new customer after OTP verify)
 * ============================================================================== */

/** How long a new customer has to finish the onboarding form after verifying
 *  their OTP. After this they must request a fresh OTP. */
export const ONBOARDING_TICKET_TTL_SECONDS = 30 * 60; // 30 min

/** Max time to wait for the per-mobile MySQL named lock that serialises
 *  customer creation (prevents duplicate rows for the same number). */
export const CUSTOMER_CREATE_LOCK_TIMEOUT_SECONDS = 5;

/* ==============================================================================
 * Account status — which values in the shared DB mean "may log in"
 * ==============================================================================
 * The web app owns these columns. Comparison is case-insensitive and trimmed.
 * Anything NOT listed here is treated as inactive (allowlist, not denylist):
 * a new status value added by the web team can never accidentally grant
 * access.
 *
 *   uc_staff.status — enum('active','suspended','left')
 *   vendors.status  — free varchar; NULL/'' on legacy rows
 *   customers / drivers — no status column → always active
 *
 * Verify the vendor values in production with:
 *   SELECT status, COUNT(*) FROM vendors GROUP BY status;
 * ============================================================================== */
export const ACTIVE_STATUS_VALUES: ReadonlySet<string> = new Set(['active']);

/** Legacy vendor rows were created before the status column existed.
 *  true  → NULL/'' vendor status is treated as active.
 *  false → only rows explicitly marked active may log in. */
export const VENDOR_NULL_STATUS_IS_ACTIVE = true;

/* ==============================================================================
 * OTP send rate limits (per mobile). Enforced in Redis before hitting MSG91.
 * ============================================================================== */

/** Max OTP sends per mobile per 10 minutes.
 *  PRODUCTION VALUE — do not raise for local testing; add the number to
 *  MSG91_TEST_MOBILES instead (test mobiles skip SMS entirely). */
export const OTP_SEND_MAX_PER_10M = 3;
/** Max OTP sends per mobile per day. PRODUCTION VALUE — see note above. */
export const OTP_SEND_MAX_PER_DAY = 10;
/** Hard cooldown between two consecutive sends to the same mobile. */
export const OTP_SEND_MIN_INTERVAL_SECONDS = 30;

/* ==============================================================================
 * SMS-pumping defenses — subnet + number-prefix hourly caps
 * ==============================================================================
 * These layer on top of the per-mobile limits above. Per-mobile caps do not
 * defend against pumping because the attack rotates target numbers — each
 * probe hits a fresh per-mobile bucket. The two limits below catch the
 * shared attributes of pumping traffic:
 *
 *   IP-block limit — attackers behind a small IP range (VPN endpoints,
 *   botnet subnets, rented server ranges) share the /24 (or /64 for IPv6).
 *   Legitimate shared traffic (corporate NAT, coworking space, campus)
 *   also shares subnets; tune upward if such traffic trips it in your logs.
 *
 *   Number-prefix limit — SMS pumping farms register blocks of numbers on
 *   a single mobile operator, which cluster on a narrow prefix range
 *   (~10k numbers per 5-char prefix in India). Tune upward if your largest
 *   legitimate operator cluster's peak hour exceeds this.
 *
 * Both are HOURLY windows in Redis. Test-mobile paths bypass both — QA
 * tooling should never trip anti-abuse limits.
 * ============================================================================== */

/** Max OTP sends per IP subnet (IPv4 /24, IPv6 /64) per hour. */
export const OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR = 100;

/** Max OTP sends per number prefix per hour. */
export const OTP_SEND_MAX_PER_PREFIX_PER_HOUR = 500;

/** How many leading characters of the mobile (including country code) form
 *  the prefix bucket. 5 covers country code + 3-digit operator prefix,
 *  e.g. '91981' groups all Airtel Delhi-ish numbers starting +91981xxxxxxx. */
export const OTP_PREFIX_LENGTH = 5;

/* ==============================================================================
 * MSG91 provider reliability — retry + circuit breaker
 * ============================================================================== */

/**
 * How many times to retry a TRANSIENT MSG91 failure inside one dispatch call.
 * "Transient" means `network`, `timeout`, or a provider 5xx — cases where the
 * request may not have reached MSG91 or their side had a temporary problem.
 * NEVER retries `wallet_low`, `template_bad`, `provider_forbidden`, or
 * `rate_limited` — retrying those either wastes money or makes rate-limit
 * throttling worse.
 *
 * The retry sends the SAME OTP value, so if MSG91 actually processed the first
 * request (but we didn't see the response), the user just gets two identical
 * SMSes and uses either one. No security impact — the code in both is the same.
 */
export const MSG91_MAX_RETRIES = 1;
/** Backoff before the retry attempt, in milliseconds. */
export const MSG91_RETRY_DELAY_MS = 500;

/**
 * Circuit breaker — after N consecutive provider-side failures within
 * MSG91_CB_WINDOW_SECONDS, we stop calling MSG91 for MSG91_CB_OPEN_SECONDS.
 * During that window, /auth/otp/request returns 503 SERVICE_UNAVAILABLE
 * immediately rather than eating an 8-second timeout per request.
 *
 * These values are tuned so a real MSG91 outage trips the breaker within a
 * handful of requests, but transient glitches (one or two failures in a busy
 * window) don't. Test-mobile sends bypass the breaker entirely.
 */
export const MSG91_CB_FAILURE_THRESHOLD = 5;
export const MSG91_CB_WINDOW_SECONDS = 300; // 5 min sliding window
export const MSG91_CB_OPEN_SECONDS = 60;

/* ==============================================================================
 * Refresh-token reuse grace window (fix M2)
 * ==============================================================================
 * A refresh token that was rotated by a normal refresh at most this many
 * seconds ago — and whose replacement session is still active — is treated
 * as the app's own duplicate request (two API calls hit 401 together and
 * both refreshed with the same token), not as theft. The server issues a
 * fresh token pair instead of revoking every session on every device.
 *
 * Outside the window, or if the replacement was logged out / revoked, the
 * normal reuse detection applies: all sessions are revoked.
 *
 * Keep it SHORT: it is also the window in which a stolen-and-replayed token
 * goes unnoticed. 10 s covers network retries and parallel 401 handlers.
 * ============================================================================== */
export const REFRESH_REUSE_GRACE_SECONDS = 10;

/* ==============================================================================
 * Refresh-session cache
 * ============================================================================== */

/** In-memory cache for auth_sessions row lookups. Disabled at MVP. */
export const SESSION_CACHE_TTL_SECONDS = 0;
