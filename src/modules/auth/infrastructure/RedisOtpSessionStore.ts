/**
 * ==============================================================================
 * RedisOtpSessionStore — production IOtpSessionStore backed by ioredis
 * ==============================================================================
 * Wraps the shared `redis` singleton. Every key is built through the typed
 * key-registry in shared/redis/keys.ts — no inline key strings here.
 *
 * All Redis operations are thin wrappers. No business logic lives here;
 * that belongs in the service layer.
 * ==============================================================================
 */

import type { IOtpSessionStore, IdempotencySnapshot } from '../ports/IOtpSessionStore.js';
import type { OtpSession, OnboardingTicket } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import { redis } from '../../../shared/redis/client.js';
import {
  otpSession,
  idempotencySnapshot,
  otpLastSent,
  otpRateMobile10m,
  otpRateMobileDay,
  otpRateIpBlock,
  otpRateNumberPrefix,
  otpVerifyFail,
  jwtDeny,
  sessionsActive,
  onboardingTicket,
} from '../../../shared/redis/keys.js';

export class RedisOtpSessionStore implements IOtpSessionStore {
  // ── OTP sessions ────────────────────────────────────────────────────────

  async setOtpSession(session: OtpSession, ttlSeconds: number): Promise<void> {
    await redis.set(otpSession(session.requestId), JSON.stringify(session), 'EX', ttlSeconds);
  }

  async getOtpSession(requestId: string): Promise<OtpSession | null> {
    const raw = await redis.get(otpSession(requestId));
    if (!raw) return null;
    return JSON.parse(raw) as OtpSession;
  }

  async deleteOtpSession(requestId: string): Promise<void> {
    await redis.del(otpSession(requestId));
  }

  // ── Idempotency ─────────────────────────────────────────────────────────

  async getIdempotencySnapshot(idempotencyKey: string): Promise<IdempotencySnapshot | null> {
    const raw = await redis.get(idempotencySnapshot(idempotencyKey));
    if (!raw) return null;
    return JSON.parse(raw) as IdempotencySnapshot;
  }

  async setIdempotencySnapshot(
    idempotencyKey: string,
    snapshot: IdempotencySnapshot,
    ttlSeconds: number,
  ): Promise<void> {
    await redis.set(
      idempotencySnapshot(idempotencyKey),
      JSON.stringify(snapshot),
      'EX',
      ttlSeconds,
    );
  }

  // ── Rate-limit counters (per-mobile) ────────────────────────────────────

  async getLastSentAt(mobile: string): Promise<number | null> {
    const raw = await redis.get(otpLastSent(mobile));
    return raw !== null ? Number(raw) : null;
  }

  async setLastSentAt(mobile: string, nowMs: number, ttlSeconds: number): Promise<void> {
    await redis.set(otpLastSent(mobile), String(nowMs), 'EX', ttlSeconds);
  }

  async getSendCount10m(mobile: string): Promise<number> {
    const raw = await redis.get(otpRateMobile10m(mobile));
    return raw !== null ? Number(raw) : 0;
  }

  async incrementSendCount10m(mobile: string): Promise<void> {
    const k = otpRateMobile10m(mobile);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 600);
  }

  async getSendCountDay(mobile: string): Promise<number> {
    const raw = await redis.get(otpRateMobileDay(mobile));
    return raw !== null ? Number(raw) : 0;
  }

  async incrementSendCountDay(mobile: string): Promise<void> {
    const k = otpRateMobileDay(mobile);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 86_400);
  }

  // ── Rate-limit counters (anti-pumping) ──────────────────────────────────

  async getSendCountIpBlock(ipBlockKey: string): Promise<number> {
    const raw = await redis.get(otpRateIpBlock(ipBlockKey));
    return raw !== null ? Number(raw) : 0;
  }

  async incrementSendCountIpBlock(ipBlockKey: string): Promise<void> {
    const k = otpRateIpBlock(ipBlockKey);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 3_600);
  }

  async getSendCountPrefix(prefix: string): Promise<number> {
    const raw = await redis.get(otpRateNumberPrefix(prefix));
    return raw !== null ? Number(raw) : 0;
  }

  async incrementSendCountPrefix(prefix: string): Promise<void> {
    const k = otpRateNumberPrefix(prefix);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, 3_600);
  }

  // ── Verify-fail fast counter ─────────────────────────────────────────────

  async incrementVerifyFail(mobile: string, windowSeconds: number): Promise<number> {
    const k = otpVerifyFail(mobile);
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSeconds);
    return n;
  }

  async deleteVerifyFail(mobile: string): Promise<void> {
    await redis.del(otpVerifyFail(mobile));
  }

  // ── JWT deny-list ────────────────────────────────────────────────────────

  async denySession(sid: string, ttlSeconds: number): Promise<void> {
    await redis.set(jwtDeny(sid), '1', 'EX', ttlSeconds);
  }

  async isSessionDenied(sid: string): Promise<boolean> {
    return (await redis.exists(jwtDeny(sid))) === 1;
  }

  // ── Active-session index ─────────────────────────────────────────────────

  async addActiveSession(role: UserRole, entityId: string, jti: string): Promise<void> {
    await redis.sadd(sessionsActive(role, entityId), jti);
  }

  async removeActiveSession(role: UserRole, entityId: string, jti: string): Promise<void> {
    await redis.srem(sessionsActive(role, entityId), jti);
  }

  async clearActiveSessions(role: UserRole, entityId: string): Promise<void> {
    await redis.del(sessionsActive(role, entityId));
  }

  async denyMandySessions(jtis: string[], ttlSeconds: number): Promise<void> {
    if (jtis.length === 0) return;
    await Promise.all(jtis.map(sid => redis.set(jwtDeny(sid), '1', 'EX', ttlSeconds)));
  }

  // ── Customer onboarding tickets ──────────────────────────────────────────

  async setOnboardingTicket(
    tokenHash: string,
    ticket: OnboardingTicket,
    ttlSeconds: number,
  ): Promise<void> {
    await redis.set(onboardingTicket(tokenHash), JSON.stringify(ticket), 'EX', ttlSeconds);
  }

  async takeOnboardingTicket(tokenHash: string): Promise<OnboardingTicket | null> {
    // MULTI/EXEC = atomic GET+DEL; works on every Redis version (GETDEL needs 6.2+).
    const k = onboardingTicket(tokenHash);
    const res = await redis.multi().get(k).del(k).exec();
    const raw = res?.[0]?.[1];
    return typeof raw === 'string' ? (JSON.parse(raw) as OnboardingTicket) : null;
  }
}
