/**
 * Port for the Redis state used by auth: OTP sessions, idempotency
 * snapshots, rate-limit counters, verify-failure counters, the JWT
 * deny-list, the active-session index and onboarding tickets.
 * Kept as one interface because it maps to one Redis client; split a group
 * out if it grows. Implementation: RedisOtpSessionStore.
 */

import type { OtpSession, RequestOtpResponseDto, OnboardingTicket } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/** One IP block's current hourly counters, after increment. Used by ip-block-guard.ts. */
export type IpBlockWindow = {
  sends: number;
  verifies: number;
  failures: number;
  /** Seconds until the window ends (≥ 1), for Retry-After. */
  ttlSeconds: number;
};

export type IdempotencySnapshot = {
  /** sha256('<mobile>|<role>'): a key reused for another mobile or role is rejected. */
  fp: string;
  response: RequestOtpResponseDto;
};

export interface IOtpSessionStore {
  // OTP sessions

  /** Stores the session under its requestId. */
  setOtpSession(session: OtpSession, ttlSeconds: number): Promise<void>;

  /** null if expired or unknown. */
  getOtpSession(requestId: string): Promise<OtpSession | null>;

  /**
   * Deletes the session and its attempt counter. Returns true only for the
   * caller that actually deleted it: of two concurrent correct verifies,
   * exactly one may log in.
   */
  deleteOtpSession(requestId: string): Promise<boolean>;

  /**
   * Atomically increments the OTP's attempt count and returns it. Called
   * before comparing the code, so parallel guesses can't exceed the limit.
   */
  incrementOtpAttempts(requestId: string, ttlSeconds: number): Promise<number>;

  // Idempotency

  /** null if unknown or expired. */
  getIdempotencySnapshot(idempotencyKey: string): Promise<IdempotencySnapshot | null>;

  setIdempotencySnapshot(
    idempotencyKey: string,
    snapshot: IdempotencySnapshot,
    ttlSeconds: number,
  ): Promise<void>;

  // Rate-limit counters (per-mobile)
  // Each is one atomic operation. There is deliberately no "read counter"
  // method: increment first, then compare the returned value.

  /** SET NX EX: true for exactly one caller per window. Stores nowMs for Retry-After. */
  tryAcquireSendCooldown(mobile: string, nowMs: number, ttlSeconds: number): Promise<boolean>;

  /** Ends the cooldown early after a definite provider failure. */
  releaseSendCooldown(mobile: string): Promise<void>;

  /** Last send time (ms) for Retry-After only; never used to allow or deny. */
  getLastSentAt(mobile: string): Promise<number | null>;

  /** Increments the 10-minute counter; returns the new value. */
  incrementSendCount10m(mobile: string): Promise<number>;

  /** Increments the daily counter; returns the new value. */
  incrementSendCountDay(mobile: string): Promise<number>;

  /** Gives back one 10-minute and one daily send (floor 0) after a definite provider failure. */
  refundSendCounts(mobile: string): Promise<void>;

  // Rate-limit counters (anti-pumping)

  /** Counts a send against the IP block's hourly window; returns its counters and TTL. */
  recordIpBlockSend(ipBlockKey: string): Promise<IpBlockWindow>;

  /** Credits a verify to the sending block. Only updates an existing window. */
  recordIpBlockVerify(ipBlockKey: string): Promise<void>;

  /**
   * Records a provider failure so outages don't lower the block's conversion
   * rate. The send still counts toward the hard cap. Existing windows only.
   */
  recordIpBlockSendFailure(ipBlockKey: string): Promise<void>;

  /** Increments the number-prefix hourly counter; returns the new value. */
  incrementSendCountPrefix(prefix: string): Promise<number>;

  // Verify-fail fast counter

  /** Increments the mobile's wrong-code count; the first increment sets the window TTL. */
  incrementVerifyFail(mobile: string, windowSeconds: number): Promise<number>;

  /** Clears the count after a successful verify or once the lock is applied. */
  deleteVerifyFail(mobile: string): Promise<void>;

  // JWT deny-list

  /** Rejects access tokens with this sid. TTL should cover the access token's lifetime. */
  denySession(sid: string, ttlSeconds: number): Promise<void>;

  isSessionDenied(sid: string): Promise<boolean>;

  // Active-session index

  /**
   * Adds a session ending at expiresAt (same as auth_sessions.expires_at).
   * Prunes expired members and expires the key with its last member.
   * Informational only; revocation uses the DB.
   */
  addActiveSession(role: UserRole, entityId: string, jti: string, expiresAt: Date): Promise<void>;

  removeActiveSession(role: UserRole, entityId: string, jti: string): Promise<void>;

  clearActiveSessions(role: UserRole, entityId: string): Promise<void>;

  /** Deny-lists many sessions at once (logout-all, token reuse). */
  denyManySessions(jtis: string[], ttlSeconds: number): Promise<void>;

  // Customer onboarding tickets

  /** Stores a ticket under sha256(token). */
  setOnboardingTicket(
    tokenHash: string,
    ticket: OnboardingTicket,
    ttlSeconds: number,
  ): Promise<void>;

  /** Atomically reads and deletes the ticket (single use). null if missing or expired. */
  takeOnboardingTicket(tokenHash: string): Promise<OnboardingTicket | null>;
}
