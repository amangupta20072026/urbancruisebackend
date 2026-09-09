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
 * ==============================================================================
 */

import type { UserRole } from '../rbac/roles.js';

/* -----------------------------------------------------------------
 * OTP flow
 * ----------------------------------------------------------------- */

/** Full OTP session — hash {mobile, otpHash, role, requestId, attempts, channel}. TTL = OTP_SESSION_TTL_SECONDS. */
export const otpSession = (requestId: string): string => `otp:session:${requestId}`;

/** Rate-limit counters per mobile (windowed). */
export const otpRateMobile10m = (mobile: string): string => `otp:rate:mobile:${mobile}:10m`;
export const otpRateMobileDay = (mobile: string): string => `otp:rate:mobile:${mobile}:1d`;

/** Last-send timestamp per mobile — used to enforce the 30-second cooldown. */
export const otpLastSent = (mobile: string): string => `otp:lastsent:${mobile}`;

/** Rate-limit per source IP (per hour). */
export const otpRateIpHour = (ip: string): string => `otp:rate:ip:${ip}:1h`;

/** Consecutive verify-failure count for a mobile. */
export const otpVerifyFail = (mobile: string): string => `otp:verify:fail:${mobile}`;

/* -----------------------------------------------------------------
 * Idempotency
 * ----------------------------------------------------------------- */

/** Response snapshot for POST /auth/otp/request. Stored as JSON string. */
export const idempotencySnapshot = (key: string): string => `idem:${key}`;

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

export const sessionsActive = (role: UserRole, entityId: string): string =>
  `sessions:active:${role}:${entityId}`;

/* -----------------------------------------------------------------
 * Provider health (populated by BullMQ pollers — not wired in MVP)
 * ----------------------------------------------------------------- */

export const healthMsg91Wallet = (): string => 'health:msg91:wallet';
export const healthMsg91Waba = (): string => 'health:msg91:waba';
export const healthMsg91Template = (name: string): string => `health:msg91:template:${name}`;

/* -----------------------------------------------------------------
 * Circuit breakers
 * ----------------------------------------------------------------- */

export const circuitBreakerMsg91Whatsapp = (): string => 'cb:msg91:whatsapp';
export const circuitBreakerMsg91Sms = (): string => 'cb:msg91:sms';
