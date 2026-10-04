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

  async deleteOtpSession(requestId: string): Promise<void> {
    this.sessions.delete(requestId);
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

  async getLastSentAt(mobile: string): Promise<number | null> {
    return this.lastSentAt.get(mobile) ?? null;
  }

  async setLastSentAt(mobile: string, nowMs: number, _ttlSeconds: number): Promise<void> {
    this.lastSentAt.set(mobile, nowMs);
  }

  async getSendCount10m(mobile: string): Promise<number> {
    return this.sendCounts10m.get(mobile) ?? 0;
  }

  async incrementSendCount10m(mobile: string): Promise<void> {
    this.sendCounts10m.set(mobile, (this.sendCounts10m.get(mobile) ?? 0) + 1);
  }

  async getSendCountDay(mobile: string): Promise<number> {
    return this.sendCountsDay.get(mobile) ?? 0;
  }

  async incrementSendCountDay(mobile: string): Promise<void> {
    this.sendCountsDay.set(mobile, (this.sendCountsDay.get(mobile) ?? 0) + 1);
  }

  async getSendCountIpBlock(ipBlockKey: string): Promise<number> {
    return this.sendCountsIpBlock.get(ipBlockKey) ?? 0;
  }

  async incrementSendCountIpBlock(ipBlockKey: string): Promise<void> {
    this.sendCountsIpBlock.set(ipBlockKey, (this.sendCountsIpBlock.get(ipBlockKey) ?? 0) + 1);
  }

  async getSendCountPrefix(prefix: string): Promise<number> {
    return this.sendCountsPrefix.get(prefix) ?? 0;
  }

  async incrementSendCountPrefix(prefix: string): Promise<void> {
    this.sendCountsPrefix.set(prefix, (this.sendCountsPrefix.get(prefix) ?? 0) + 1);
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

  async denyMandySessions(jtis: string[], _ttlSeconds: number): Promise<void> {
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
