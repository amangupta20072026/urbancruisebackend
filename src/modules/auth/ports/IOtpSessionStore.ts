/**
 * ==============================================================================
 * IOtpSessionStore — port for OTP session + rate-limit state
 * ==============================================================================
 * Abstracts every Redis operation the OTP send/verify flow touches so the
 * service layer depends on this interface, not on the concrete ioredis client.
 *
 * SCOPE — three responsibility clusters, all owned by the OTP flow:
 *
 *   1. OTP sessions         — create / load / delete the short-lived session
 *                             object stored during send→verify window.
 *   2. Idempotency          — snapshot / replay a send response so identical
 *                             retries within 24 h get the cached answer.
 *   3. Rate-limit counters  — cooldown, per-mobile windowed counters, anti-
 *                             pumping IP-block and number-prefix buckets.
 *   4. Verify-fail counters — Redis fast counter that mirrors the DB lock
 *                             threshold check so we can fail-fast without a
 *                             DB round-trip on every wrong attempt.
 *   5. JWT deny-list        — revoke an access-token sid so it is rejected
 *                             immediately even before the JWT expires.
 *   6. Active-session index — SADD / SREM / DEL the set that tracks which
 *                             jtis are live for a given (role, entityId).
 *
 * WHY NOT SPLIT FURTHER?
 *   All six clusters share one underlying connection (ioredis) and the same
 *   namespace conventions from redis/keys.ts. Splitting into e.g.
 *   IOtpSessionStore + IRateLimitStore + ISessionIndex would be correct
 *   ISP-wise but would require injecting three objects into every service
 *   function. One composite interface that maps 1-to-1 with the real
 *   infrastructure file is the pragmatic balance for this codebase's size.
 *   If any cluster grows significantly, extract it then.
 *
 * IMPLEMENTATIONS
 *   RedisOtpSessionStore  — wraps the ioredis singleton (production)
 *   InMemoryOtpSessionStore — Map/Set in-process (unit tests, no Redis needed)
 * ==============================================================================
 */

import type { OtpSession, RequestOtpResponseDto, OnboardingTicket } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/* --------------------------------------------------------------------------
 * Idempotency snapshot shape — stored as JSON, keyed by idempotency-key.
 * -------------------------------------------------------------------------- */

export type IdempotencySnapshot = {
  /** sha256('<mobile>|<role>') — binds the snapshot to the exact (mobile, role)
   *  that produced it so a stolen key can't replay a different identity. */
  fp: string;
  response: RequestOtpResponseDto;
};

/* --------------------------------------------------------------------------
 * Interface
 * -------------------------------------------------------------------------- */

export interface IOtpSessionStore {
  // ── OTP sessions ──────────────────────────────────────────────────────────

  /**
   * Persist an OTP session for `ttlSeconds`. The key is the requestId embedded
   * in the session object — the store derives the Redis key internally.
   */
  setOtpSession(session: OtpSession, ttlSeconds: number): Promise<void>;

  /**
   * Load an OTP session by requestId. Returns null when not found (expired
   * or never existed).
   */
  getOtpSession(requestId: string): Promise<OtpSession | null>;

  /**
   * Delete an OTP session immediately (single-use enforcement after
   * successful verify) together with its attempt counter.
   *
   * Returns true ONLY for the caller whose delete actually removed the
   * session. Two concurrent verifies with the correct code both reach this
   * call; exactly one gets `true` and may mint a login session — the other
   * must be rejected. This is the atomic "claim" of the OTP.
   */
  deleteOtpSession(requestId: string): Promise<boolean>;

  /**
   * ATOMICALLY increment the verify-attempt counter for one OTP session and
   * return the new value. Called BEFORE the code is compared, so N parallel
   * guesses receive the values 1..N and only the first OTP_MAX_VERIFY_ATTEMPTS
   * are ever evaluated. TTL (set on first increment) should match the
   * session's TTL.
   */
  incrementOtpAttempts(requestId: string, ttlSeconds: number): Promise<number>;

  // ── Idempotency ───────────────────────────────────────────────────────────

  /**
   * Load a previously stored idempotency snapshot. Returns null when the key
   * is unknown or has expired.
   */
  getIdempotencySnapshot(idempotencyKey: string): Promise<IdempotencySnapshot | null>;

  /**
   * Persist an idempotency snapshot for `ttlSeconds`.
   */
  setIdempotencySnapshot(
    idempotencyKey: string,
    snapshot: IdempotencySnapshot,
    ttlSeconds: number,
  ): Promise<void>;

  // ── Rate-limit counters (per-mobile) ──────────────────────────────────────
  //
  // CONCURRENCY CONTRACT — every method below is a single atomic operation.
  // There are deliberately NO separate "read the counter" methods: a
  // read-then-write check lets N parallel requests all observe the same
  // under-cap value and all pass (that was the SMS-bombing race). Callers
  // must increment FIRST and compare the returned post-increment value.

  /**
   * Try to start the resend cooldown for `mobile` (Redis: SET NX EX).
   * Returns true for exactly ONE caller per cooldown window; every concurrent
   * or subsequent caller gets false until `ttlSeconds` elapse. Stores `nowMs`
   * so a loser can compute its Retry-After.
   */
  tryAcquireSendCooldown(mobile: string, nowMs: number, ttlSeconds: number): Promise<boolean>;

  /**
   * Release the cooldown early. Only used when the provider definitively
   * failed to send, so the user may retry immediately.
   */
  releaseSendCooldown(mobile: string): Promise<void>;

  /**
   * Unix-ms timestamp stored by the winning tryAcquireSendCooldown, or null.
   * Informational only (Retry-After hint) — never used for the allow/deny
   * decision.
   */
  getLastSentAt(mobile: string): Promise<number | null>;

  /**
   * Atomically increment the 10-minute counter and return the NEW value.
   * TTL (600 s) is set on first increment, inside the same atomic step.
   */
  incrementSendCount10m(mobile: string): Promise<number>;

  /**
   * Atomically increment the daily counter and return the NEW value.
   * TTL (86 400 s) is set on first increment, inside the same atomic step.
   */
  incrementSendCountDay(mobile: string): Promise<number>;

  /**
   * Refund one unit of the per-mobile 10-minute and daily counters (never
   * below zero). Used only when the provider definitively failed, so a real
   * user is not locked out by an MSG91 outage they did not cause.
   */
  refundSendCounts(mobile: string): Promise<void>;

  // ── Rate-limit counters (anti-pumping) ────────────────────────────────────

  /**
   * Atomically increment the IP-block hourly counter (IPv4 /24 or IPv6 /64,
   * already bucketed e.g. "v4:203.0.113") and return the NEW value. TTL
   * (3 600 s) is set on first increment.
   */
  incrementSendCountIpBlock(ipBlockKey: string): Promise<number>;

  /**
   * Atomically increment the number-prefix hourly counter and return the NEW
   * value. TTL (3 600 s) is set on first increment.
   */
  incrementSendCountPrefix(prefix: string): Promise<number>;

  // ── Verify-fail fast counter ──────────────────────────────────────────────

  /**
   * Increment the in-Redis verify-failure counter for a mobile.
   * Returns the new count. If this is the first increment, the implementation
   * sets `windowSeconds` as the TTL so the counter expires automatically.
   */
  incrementVerifyFail(mobile: string, windowSeconds: number): Promise<number>;

  /**
   * Delete the verify-failure counter (called after successful verify or after
   * the DB-level lock has been applied).
   */
  deleteVerifyFail(mobile: string): Promise<void>;

  // ── JWT deny-list ─────────────────────────────────────────────────────────

  /**
   * Add a session id to the deny-list. Any access token whose `sid` claim
   * matches will be rejected by the authenticate middleware.
   * `ttlSeconds` should equal the remaining lifetime of the access token.
   */
  denySession(sid: string, ttlSeconds: number): Promise<void>;

  /**
   * Check whether a session id is on the deny-list.
   */
  isSessionDenied(sid: string): Promise<boolean>;

  // ── Active-session index ──────────────────────────────────────────────────

  /**
   * Add a jti to the active-session set for (role, entityId).
   */
  addActiveSession(role: UserRole, entityId: string, jti: string): Promise<void>;

  /**
   * Remove a jti from the active-session set (logout / rotation).
   */
  removeActiveSession(role: UserRole, entityId: string, jti: string): Promise<void>;

  /**
   * Delete the entire active-session set (logout-all).
   */
  clearActiveSessions(role: UserRole, entityId: string): Promise<void>;

  /**
   * Add multiple jtis to the deny-list concurrently (used by logout-all and
   * token-reuse detection to revoke every active access token at once).
   */
  denyManySessions(jtis: string[], ttlSeconds: number): Promise<void>;

  // ── Customer onboarding tickets ───────────────────────────────────────────

  /** Store a ticket under sha256(token). */
  setOnboardingTicket(
    tokenHash: string,
    ticket: OnboardingTicket,
    ttlSeconds: number,
  ): Promise<void>;

  /** Atomically read AND delete the ticket (single use). null when missing/expired. */
  takeOnboardingTicket(tokenHash: string): Promise<OnboardingTicket | null>;
}
