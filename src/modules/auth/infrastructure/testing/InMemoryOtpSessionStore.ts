/**
 * ==============================================================================
 * InMemoryOtpSessionStore — test double for IOtpSessionStore
 * ==============================================================================
 * Uses plain JS Maps and Sets. No Redis, no network, no TTL enforcement
 * (TTL parameters are accepted but ignored — tests control time explicitly).
 *
 * USAGE IN TESTS:
 *
 *   import { InMemoryOtpSessionStore } from '.../testing/InMemoryOtpSessionStore.js';
 *   import { buildAuthDeps } from '.../infrastructure/AuthContainer.js';
 *
 *   const store = new InMemoryOtpSessionStore();
 *   const deps = buildAuthDeps({ store });
 *
 *   // seed a session before calling verifyOtp
 *   store.seedOtpSession({ requestId: 'req-1', mobile: '919999999999', ... });
 *
 *   // assert deny-list after logout
 *   expect(store.isDenied('jti-abc')).toBe(true);
 *
 * All internal state is exposed as plain Maps/Sets for easy assertion.
 * ==============================================================================
 */

import type { IOtpSessionStore, IdempotencySnapshot } from '../../ports/IOtpSessionStore.js';
import type { OtpSession, OnboardingTicket } from '../../types.js';
import type { UserRole } from '../../../../shared/rbac/roles.js';

export class InMemoryOtpSessionStore implements IOtpSessionStore {
  // ── Internal state (readable by tests) ──────────────────────────────────

  readonly sessions = new Map<string, OtpSession>();
  readonly otpAttempts = new Map<string, number>();
  readonly idempotencySnapshots = new Map<string, IdempotencySnapshot>();
  readonly lastSentAt = new Map<string, number>();
  readonly sendCounts10m = new Map<string, number>();
  readonly sendCountsDay = new Map<string, number>();
  readonly sendCountsIpBlock = new Map<string, number>();
  readonly sendCountsPrefix = new Map<string, number>();
  readonly verifyFails = new Map<string, number>();
  readonly deniedSids = new Set<string>();
  readonly activeSessions = new Map<string, Set<string>>(); // `${role}:${entityId}` → Set<jti>
  readonly onboardingTickets = new Map<string, OnboardingTicket>(); // key: sha256(token)

  // ── Seed helpers (test use only) ─────────────────────────────────────────

  seedOtpSession(session: OtpSession): void {
    this.sessions.set(session.requestId, session);
  }

  isDenied(sid: string): boolean {
    return this.deniedSids.has(sid);
  }

  getActiveSessions(role: UserRole, entityId: string): Set<string> {
    return this.activeSessions.get(`${role}:${entityId}`) ?? new Set();
  }

  reset(): void {
    this.sessions.clear();
    this.otpAttempts.clear();
    this.idempotencySnapshots.clear();
    this.lastSentAt.clear();
    this.sendCounts10m.clear();
    this.sendCountsDay.clear();
    this.sendCountsIpBlock.clear();
    this.sendCountsPrefix.clear();
    this.verifyFails.clear();
    this.deniedSids.clear();
    this.activeSessions.clear();
    this.onboardingTickets.clear();
  }

  // ── IOtpSessionStore implementation ─────────────────────────────────────

  async setOtpSession(session: OtpSession, _ttlSeconds: number): Promise<void> {
    this.sessions.set(session.requestId, session);
  }

  async getOtpSession(requestId: string): Promise<OtpSession | null> {
    return this.sessions.get(requestId) ?? null;
  }

  async deleteOtpSession(requestId: string): Promise<boolean> {
    this.otpAttempts.delete(requestId);
    return this.sessions.delete(requestId);
  }

  async incrementOtpAttempts(requestId: string, _ttlSeconds: number): Promise<number> {
    const next = (this.otpAttempts.get(requestId) ?? 0) + 1;
    this.otpAttempts.set(requestId, next);
    return next;
  }

  async getIdempotencySnapshot(idempotencyKey: string): Promise<IdempotencySnapshot | null> {
    return this.idempotencySnapshots.get(idempotencyKey) ?? null;
  }

  async setIdempotencySnapshot(
    idempotencyKey: string,
    snapshot: IdempotencySnapshot,
    _ttlSeconds: number,
  ): Promise<void> {
    this.idempotencySnapshots.set(idempotencyKey, snapshot);
  }

  /**
   * Mirrors SET NX EX: succeeds only when no cooldown is active. A stored
   * timestamp older than the TTL counts as expired (emulates Redis expiry),
   * so tests can seed `lastSentAt` with an old value to simulate elapsed time.
   * Check-and-set happens synchronously, so it is atomic on the event loop.
   */
  async tryAcquireSendCooldown(
    mobile: string,
    nowMs: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const prev = this.lastSentAt.get(mobile);
    if (prev !== undefined && nowMs - prev < ttlSeconds * 1000) return false;
    this.lastSentAt.set(mobile, nowMs);
    return true;
  }

  async releaseSendCooldown(mobile: string): Promise<void> {
    this.lastSentAt.delete(mobile);
  }

  async getLastSentAt(mobile: string): Promise<number | null> {
    return this.lastSentAt.get(mobile) ?? null;
  }

  async incrementSendCount10m(mobile: string): Promise<number> {
    return bump(this.sendCounts10m, mobile);
  }

  async incrementSendCountDay(mobile: string): Promise<number> {
    return bump(this.sendCountsDay, mobile);
  }

  async refundSendCounts(mobile: string): Promise<void> {
    for (const m of [this.sendCounts10m, this.sendCountsDay]) {
      const v = m.get(mobile) ?? 0;
      if (v > 0) m.set(mobile, v - 1);
    }
  }

  async incrementSendCountIpBlock(ipBlockKey: string): Promise<number> {
    return bump(this.sendCountsIpBlock, ipBlockKey);
  }

  async incrementSendCountPrefix(prefix: string): Promise<number> {
    return bump(this.sendCountsPrefix, prefix);
  }

  async incrementVerifyFail(mobile: string, _windowSeconds: number): Promise<number> {
    const next = (this.verifyFails.get(mobile) ?? 0) + 1;
    this.verifyFails.set(mobile, next);
    return next;
  }

  async deleteVerifyFail(mobile: string): Promise<void> {
    this.verifyFails.delete(mobile);
  }

  async denySession(sid: string, _ttlSeconds: number): Promise<void> {
    this.deniedSids.add(sid);
  }

  async isSessionDenied(sid: string): Promise<boolean> {
    return this.deniedSids.has(sid);
  }

  async addActiveSession(role: UserRole, entityId: string, jti: string): Promise<void> {
    const key = `${role}:${entityId}`;
    const set = this.activeSessions.get(key) ?? new Set<string>();
    set.add(jti);
    this.activeSessions.set(key, set);
  }

  async removeActiveSession(role: UserRole, entityId: string, jti: string): Promise<void> {
    this.activeSessions.get(`${role}:${entityId}`)?.delete(jti);
  }

  async clearActiveSessions(role: UserRole, entityId: string): Promise<void> {
    this.activeSessions.delete(`${role}:${entityId}`);
  }

  async denyManySessions(jtis: string[], _ttlSeconds: number): Promise<void> {
    for (const sid of jtis) this.deniedSids.add(sid);
  }

  async setOnboardingTicket(
    tokenHash: string,
    ticket: OnboardingTicket,
    _ttlSeconds: number,
  ): Promise<void> {
    this.onboardingTickets.set(tokenHash, ticket);
  }

  async takeOnboardingTicket(tokenHash: string): Promise<OnboardingTicket | null> {
    const t = this.onboardingTickets.get(tokenHash) ?? null;
    this.onboardingTickets.delete(tokenHash);
    return t;
  }
}

/** Synchronous read-modify-write: atomic on the single-threaded event loop,
 *  exactly like a Redis INCR from the caller's point of view. */
function bump(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}
