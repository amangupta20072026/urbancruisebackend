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

import type {
  IOtpSessionStore,
  IdempotencySnapshot,
  IpBlockWindow,
} from '../ports/IOtpSessionStore.js';
import type { OtpSession, OnboardingTicket } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import { redis } from '../../../shared/redis/client.js';
import {
  otpSession,
  otpAttempts,
  idempotencySnapshot,
  otpLastSent,
  otpRateMobile10m,
  otpRateMobileDay,
  otpIpBlockWindow,
  otpRateNumberPrefix,
  otpVerifyFail,
  jwtDeny,
  sessionsActive,
  legacySessionsActiveSet,
  onboardingTicket,
} from '../../../shared/redis/keys.js';

/**
 * INCR + EXPIRE as ONE atomic step. Sets the TTL on the first increment, and
 * also repairs a key that somehow has no TTL (TTL = -1) so a counter can
 * never become permanent and lock a number out forever.
 *   KEYS[1] = counter key, ARGV[1] = ttl seconds. Returns the new value.
 */
const INCR_WITH_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n`;

/** DECR that never goes below zero and never creates a key. KEYS[1] = counter. */
const DECR_FLOOR_ZERO = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * IP-block window send (finding M4) — ONE atomic step:
 *   HINCRBY s, set TTL on creation (or repair a TTL-less key), read v / f.
 *   KEYS[1] = window hash, ARGV[1] = window seconds.
 *   Returns { s, v, f, ttlSeconds }.
 */
const IP_BLOCK_SEND = `
local s = redis.call('HINCRBY', KEYS[1], 's', 1)
local ttl = redis.call('TTL', KEYS[1])
if s == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local vf = redis.call('HMGET', KEYS[1], 'v', 'f')
return { s, tonumber(vf[1] or '0'), tonumber(vf[2] or '0'), ttl }`;

/** HINCRBY a field ONLY if the window already exists (never creates a key,
 *  never touches the TTL). KEYS[1] = window hash, ARGV[1] = field. */
const HINCR_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
end
return 0`;

/**
 * Live-session index add (finding L3) — ONE atomic step:
 *   1. drop members whose expiry (score, epoch ms) is already past,
 *   2. add this session with its expiry,
 *   3. set the key to expire with its LATEST member.
 * KEYS[1] = index ZSET, ARGV[1] = now ms, ARGV[2] = expiry ms, ARGV[3] = jti.
 */
const SESSION_INDEX_ADD = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
local last = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], last[2])
return 1`;

/** Window length for the IP-block hash. */
const IP_BLOCK_WINDOW_SECONDS = 3_600;

async function incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
  return Number(await redis.eval(INCR_WITH_TTL, 1, key, ttlSeconds));
}

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

  async deleteOtpSession(requestId: string): Promise<boolean> {
    // Delete the session key ON ITS OWN so DEL's count tells us whether THIS
    // call removed it. Redis serialises the DELs: exactly one concurrent
    // caller sees 1 (the claim); every other caller sees 0.
    const removed = await redis.del(otpSession(requestId));
    await redis.del(otpAttempts(requestId));
    return removed === 1;
  }

  async incrementOtpAttempts(requestId: string, ttlSeconds: number): Promise<number> {
    return incrWithTtl(otpAttempts(requestId), ttlSeconds);
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

  // ── Rate-limit counters (per-mobile) — all atomic ──────────────────────

  async tryAcquireSendCooldown(
    mobile: string,
    nowMs: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const res = await redis.set(otpLastSent(mobile), String(nowMs), 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async releaseSendCooldown(mobile: string): Promise<void> {
    await redis.del(otpLastSent(mobile));
  }

  async getLastSentAt(mobile: string): Promise<number | null> {
    const raw = await redis.get(otpLastSent(mobile));
    return raw !== null ? Number(raw) : null;
  }

  async incrementSendCount10m(mobile: string): Promise<number> {
    return incrWithTtl(otpRateMobile10m(mobile), 600);
  }

  async incrementSendCountDay(mobile: string): Promise<number> {
    return incrWithTtl(otpRateMobileDay(mobile), 86_400);
  }

  async refundSendCounts(mobile: string): Promise<void> {
    await Promise.all([
      redis.eval(DECR_FLOOR_ZERO, 1, otpRateMobile10m(mobile)),
      redis.eval(DECR_FLOOR_ZERO, 1, otpRateMobileDay(mobile)),
    ]);
  }

  // ── Rate-limit counters (anti-pumping) — all atomic ─────────────────────

  async recordIpBlockSend(ipBlockKey: string): Promise<IpBlockWindow> {
    const raw = (await redis.eval(
      IP_BLOCK_SEND,
      1,
      otpIpBlockWindow(ipBlockKey),
      IP_BLOCK_WINDOW_SECONDS,
    )) as [number, number, number, number];
    return {
      sends: Number(raw[0]),
      verifies: Number(raw[1]),
      failures: Number(raw[2]),
      ttlSeconds: Math.max(1, Number(raw[3])),
    };
  }

  async recordIpBlockVerify(ipBlockKey: string): Promise<void> {
    await redis.eval(HINCR_IF_EXISTS, 1, otpIpBlockWindow(ipBlockKey), 'v');
  }

  async recordIpBlockSendFailure(ipBlockKey: string): Promise<void> {
    await redis.eval(HINCR_IF_EXISTS, 1, otpIpBlockWindow(ipBlockKey), 'f');
  }

  async incrementSendCountPrefix(prefix: string): Promise<number> {
    return incrWithTtl(otpRateNumberPrefix(prefix), 3_600);
  }

  // ── Verify-fail fast counter ─────────────────────────────────────────────

  async incrementVerifyFail(mobile: string, windowSeconds: number): Promise<number> {
    return incrWithTtl(otpVerifyFail(mobile), windowSeconds);
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

  async addActiveSession(
    role: UserRole,
    entityId: string,
    jti: string,
    expiresAt: Date,
  ): Promise<void> {
    await Promise.all([
      redis.eval(
        SESSION_INDEX_ADD,
        1,
        sessionsActive(role, entityId),
        Date.now(),
        expiresAt.getTime(),
        jti,
      ),
      // Separate command (not inside the script) so the two keys never need
      // to share a cluster slot. UNLINK frees memory off the main thread.
      redis.unlink(legacySessionsActiveSet(role, entityId)),
    ]);
  }

  async removeActiveSession(role: UserRole, entityId: string, jti: string): Promise<void> {
    await redis.zrem(sessionsActive(role, entityId), jti);
  }

  async clearActiveSessions(role: UserRole, entityId: string): Promise<void> {
    await redis.unlink(sessionsActive(role, entityId), legacySessionsActiveSet(role, entityId));
  }

  async denyManySessions(jtis: string[], ttlSeconds: number): Promise<void> {
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
