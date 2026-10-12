/**
 * All Redis key names. Build every key here so key patterns stay in one place.
 * Prefixes: otp, idem, mobile, jwt:deny, sessions, health, cb, rl, auth:onboard.
 */

import type { UserRole } from '../rbac/roles.js';

/* ---------- OTP ---------- */

/** OTP session (JSON string). */
export const otpSession = (requestId: string): string => `otp:session:${requestId}`;

/** Verify attempts for one OTP; deleted with the session. */
export const otpAttempts = (requestId: string): string => `otp:attempts:${requestId}`;

/** OTP send counters per mobile. */
export const otpRateMobile10m = (mobile: string): string => `otp:rate:mobile:${mobile}:10m`;
export const otpRateMobileDay = (mobile: string): string => `otp:rate:mobile:${mobile}:1d`;

/** Resend cooldown (SET NX EX). Value is the last send time, used for
 *  Retry-After. */
export const otpLastSent = (mobile: string): string => `otp:lastsent:${mobile}`;

/** Hourly hash per IP block: s = sends, v = verifies, f = provider failures.
 *  "v2" avoids a type clash with an older string key of a similar name. */
export const otpIpBlockWindow = (ipBlock: string): string => `otp:ipblock:v2:${ipBlock}:1h`;

/** Hourly OTP send counter per number prefix. */
export const otpRateNumberPrefix = (prefix: string): string => `otp:rate:prefix:${prefix}:1h`;

/** Failed verify count per mobile within the lock window. */
export const otpVerifyFail = (mobile: string): string => `otp:verify:fail:${mobile}`;

/* ---------- Idempotency ---------- */

/** Saved /auth/otp/request response: { fp: sha256('<mobile>|<role>'),
 *  response }. fp stops one key being reused for another mobile or role. */
export const idempotencySnapshot = (key: string): string => `idem:v2:${key}`;

/* ---------- Mobile registry cache ---------- */

/** Not used yet. */
export const mobileFlagsCache = (mobile: string): string => `mobile:flags:${mobile}`;

/* ---------- JWT deny-list ---------- */

/** Revoked session id (sid claim). */
export const jwtDeny = (sid: string): string => `jwt:deny:${sid}`;

/* ---------- Active sessions ---------- */

/** Sorted set of an account's sessions: member = jti, score = expiry (ms).
 *  Expired members are pruned on add; the key expires with its last member. */
export const sessionsActive = (role: UserRole, entityId: string): string =>
  `sessions:live:${role}:${entityId}`;

/** Old session set format. Only deleted, never written. Remove this once no
 *  such keys remain in any environment. */
export const legacySessionsActiveSet = (role: UserRole, entityId: string): string =>
  `sessions:active:${role}:${entityId}`;

/* ---------- Provider health ---------- */

/** Not used yet. */
export const healthMsg91Wallet = (): string => 'health:msg91:wallet';

/* ---------- HTTP rate limiters ---------- */

/** Prefix per limiter; the store appends the client key. */
export const rateLimitPrefix = (limiterName: string): string => `rl:${limiterName}:`;

/* ---------- Circuit breakers ---------- */

export const circuitBreakerMsg91Sms = (): string => 'cb:msg91:sms';

/* ---------- Onboarding ticket ---------- */

/** Single-use ticket for /auth/customer/onboard, keyed by the token's
 *  SHA-256 so stored keys are not usable tokens. */
export const onboardingTicket = (tokenHash: string): string => `auth:onboard:${tokenHash}`;
