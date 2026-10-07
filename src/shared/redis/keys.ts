/**
 * ==============================================================================
 * Redis key registry
 * ==============================================================================
 * Every key the app writes to Redis goes through a builder here. If you're
 * about to inline a `redis.get(\`foo:${x}\`)` — stop and add it below. The
 * benefit is that a `redis-cli --scan --pattern 'otp:*' | wc -l` on prod
 * always matches what code is actually writing.
 *
 * NAMESPACE CONVENTIONS:
 *   otp:*        — OTP flow (sessions, counters, cooldowns)
 *   idem:*       — idempotency snapshots
 *   mobile:*     — per-mobile flags cache (write-through of mobile_registry)
 *   jwt:deny:*   — revoked access-token session ids (deny-list)
 *   sessions:*   — per-entity active session index
 *   health:*     — provider health mirror (populated by BullMQ pollers)
 *   cb:*         — circuit-breaker state
 *   rl:*         — HTTP rate-limiter buckets (shared across PM2 workers)
 * ==============================================================================
 */

import type { UserRole } from '../rbac/roles.js';

/* -----------------------------------------------------------------
 * OTP flow
 * ----------------------------------------------------------------- */

/** Full OTP session — hash {mobile, otpHash, role, requestId, attempts, channel}. TTL = OTP_SESSION_TTL_SECONDS. */
export const otpSession = (requestId: string): string => `otp:session:${requestId}`;

/** Verify-attempt counter for ONE OTP session. Incremented atomically BEFORE
 *  the code is compared, so parallel guesses cannot exceed the per-OTP cap.
 *  TTL = OTP_SESSION_TTL_SECONDS; deleted together with the session. */
export const otpAttempts = (requestId: string): string => `otp:attempts:${requestId}`;

/** Rate-limit counters per mobile (windowed). */
export const otpRateMobile10m = (mobile: string): string => `otp:rate:mobile:${mobile}:10m`;
export const otpRateMobileDay = (mobile: string): string => `otp:rate:mobile:${mobile}:1d`;

/** Resend cooldown per mobile. Written with SET NX EX — its existence IS the
 *  cooldown (atomic); the stored value is the send time, used for Retry-After. */
export const otpLastSent = (mobile: string): string => `otp:lastsent:${mobile}`;

/** Rate-limit per source IP (per hour). */
export const otpRateIpHour = (ip: string): string => `otp:rate:ip:${ip}:1h`;

/** Hourly window per IP subnet (IPv4 /24, IPv6 /64) — a HASH with fields
 *  s (sends), v (verifies), f (provider failures). Catches SMS pumping that
 *  clusters in a small IP range while letting busy carrier-CGNAT ranges
 *  through when their OTPs are actually being verified (finding M4).
 *
 *  `v2` because the previous key at `otp:rate:ipblock:<block>:1h` was a
 *  plain STRING counter: reusing that name for a HASH would raise WRONGTYPE
 *  on every request for up to an hour after deploy. Old keys expire on
 *  their own (1 h TTL). */
export const otpIpBlockWindow = (ipBlock: string): string => `otp:ipblock:v2:${ipBlock}:1h`;

/** Rate-limit per mobile-number prefix (per hour). Catches SMS pumping
 *  farms that hold blocks of numbers on a single operator's pool, which
 *  cluster on a narrow prefix range. */
export const otpRateNumberPrefix = (prefix: string): string => `otp:rate:prefix:${prefix}:1h`;

/** Consecutive verify-failure count for a mobile. */
export const otpVerifyFail = (mobile: string): string => `otp:verify:fail:${mobile}`;

/* -----------------------------------------------------------------
 * Idempotency
 * ----------------------------------------------------------------- */

/** Response snapshot for POST /auth/otp/request. Value is a JSON blob:
 *  { fp: sha256('<mobile>|<role>'), response: RequestOtpResponseDto }.
 *  The fingerprint binding rejects replays of the same key with a different
 *  (mobile, role) — see the top-of-file comment in auth/service.ts.
 *
 *  Version prefix `v2:` isolates this new format from any pre-existing
 *  legacy snapshots (which stored the response directly, without the fp
 *  wrapper). Legacy ones expire naturally within IDEMPOTENCY_TTL_SECONDS
 *  (24h) after this deploy — no double-parse risk. */
export const idempotencySnapshot = (key: string): string => `idem:v2:${key}`;

/* -----------------------------------------------------------------
 * Mobile registry cache (write-through of mysql mobile_registry)
 * ----------------------------------------------------------------- */

/** Hash of the DB row. TTL 5m. Invalidated on any DB write. */
export const mobileFlagsCache = (mobile: string): string => `mobile:flags:${mobile}`;

/* -----------------------------------------------------------------
 * JWT deny-list (post-logout / post-revocation)
 * ----------------------------------------------------------------- */

/** Access-token session id (sid claim) → '1'. TTL = remaining access token life. */
export const jwtDeny = (sid: string): string => `jwt:deny:${sid}`;

/* -----------------------------------------------------------------
 * Session index — quickly enumerate active sessions for one entity
 * ----------------------------------------------------------------- */

/** Live-session index for one account (finding L3). A SORTED SET:
 *  member = session jti, score = that session's expiry (epoch ms, same
 *  value as auth_sessions.expires_at). Expired members are pruned on every
 *  add, and the key's own expiry is set to its LAST member's expiry, so it
 *  can neither grow forever nor outlive the sessions it lists.
 *
 *  New name on purpose: the old index below was a plain SET, and reusing
 *  its name for a ZSET would raise WRONGTYPE on accounts that still have
 *  one. Its prefix (`sessions:live:`) does not overlap `sessions:active:`,
 *  so a scan for the legacy pattern can never match a live key. */
export const sessionsActive = (role: UserRole, entityId: string): string =>
  `sessions:live:${role}:${entityId}`;

/** LEGACY (pre-L3) active-session SET — no TTL, never pruned. No longer
 *  written. Deleted opportunistically on login/refresh/logout-all for the
 *  same account; leftovers for inactive accounts are removed by the
 *  one-off cleanup in the L3 deploy notes. Remove this helper once that
 *  cleanup has run in every environment. */
export const legacySessionsActiveSet = (role: UserRole, entityId: string): string =>
  `sessions:active:${role}:${entityId}`;

/* -----------------------------------------------------------------
 * Provider health (populated by BullMQ pollers — not wired in MVP)
 * ----------------------------------------------------------------- */

export const healthMsg91Wallet = (): string => 'health:msg91:wallet';

/* -----------------------------------------------------------------
 * HTTP rate limiters (express-rate-limit + rate-limit-redis)
 * -----------------------------------------------------------------
 * One prefix per named limiter, shared by every PM2 worker. The store
 * appends the client key (IP, or IP:phone for the OTP limiter).
 * ----------------------------------------------------------------- */
export const rateLimitPrefix = (limiterName: string): string => `rl:${limiterName}:`;

/* -----------------------------------------------------------------
 * Circuit breakers
 * ----------------------------------------------------------------- */

export const circuitBreakerMsg91Sms = (): string => 'cb:msg91:sms';

/* -----------------------------------------------------------------
 * Customer onboarding ticket — issued after a NEW customer verifies their
 * OTP, consumed (atomically, single-use) by POST /auth/customer/onboard.
 * Keyed by sha256(token) so a Redis dump never exposes a usable token.
 * ----------------------------------------------------------------- */
export const onboardingTicket = (tokenHash: string): string => `auth:onboard:${tokenHash}`;
