/**
 * IOtpSessionStore backed by Redis. All keys come from shared/redis/keys.ts.
 * Multi-step updates run as Lua scripts so each is atomic.
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
 * Atomic INCR + EXPIRE. Sets the TTL on first increment and repairs a key
 * with no TTL, so a counter can never lock a number out forever.
 * KEYS[1] = counter, ARGV[1] = ttl seconds. Returns the new value.
 */
const INCR_WITH_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n`;

/** DECR that never goes below zero or creates a key. KEYS[1] = counter. */
const DECR_FLOOR_ZERO = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

/**
 * Atomically counts a send in an IP-block window (sets or repairs the TTL)
 * and reads the counters. KEYS[1] = window hash, ARGV[1] = window seconds.
 * Returns { s, v, f, ttlSeconds }.
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

/**
 * HINCRBY only if the window exists; never creates a key or changes the TTL.
 * KEYS[1] = window hash, ARGV[1] = field.
 */
const HINCR_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
end
return 0`;

/**
 * Atomically adds a session to the index: drops expired members, adds this
 * one (score = expiry ms) and expires the key with its latest member.
 * KEYS[1] = ZSET, ARGV[1] = now ms, ARGV[2] = expiry ms, ARGV[3] = jti.
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
  // OTP sessions

  async setOtpSession(session: OtpSession, ttlSeconds: number): Promise<void> {
    await redis.set(otpSession(session.requestId), JSON.stringify(session), 'EX', ttlSeconds);
  }

  async getOtpSession(requestId: string): Promise<OtpSession | null> {
    const raw = await redis.get(otpSession(requestId));
    if (!raw) return null;
    return JSON.parse(raw) as OtpSession;
  }

  async deleteOtpSession(requestId: string): Promise<boolean> {
    // DEL the session alone: exactly one concurrent caller gets 1 (the claim).
    const removed = await redis.del(otpSession(requestId));
    await redis.del(otpAttempts(requestId));
    return removed === 1;
  }

  async incrementOtpAttempts(requestId: string, ttlSeconds: number): Promise<number> {
    return incrWithTtl(otpAttempts(requestId), ttlSeconds);
  }

  // Idempotency

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

  // Rate-limit counters (per-mobile)

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

  // Rate-limit counters (anti-pumping)

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

  // Verify-fail fast counter

  async incrementVerifyFail(mobile: string, windowSeconds: number): Promise<number> {
    return incrWithTtl(otpVerifyFail(mobile), windowSeconds);
  }

  async deleteVerifyFail(mobile: string): Promise<void> {
    await redis.del(otpVerifyFail(mobile));
  }

  // JWT deny-list

  async denySession(sid: string, ttlSeconds: number): Promise<void> {
    await redis.set(jwtDeny(sid), '1', 'EX', ttlSeconds);
  }

  async isSessionDenied(sid: string): Promise<boolean> {
    return (await redis.exists(jwtDeny(sid))) === 1;
  }

  // Active-session index

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
      // Removes the legacy set. Outside the script so the keys needn't share a cluster slot.
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

  // Customer onboarding tickets

  async setOnboardingTicket(
    tokenHash: string,
    ticket: OnboardingTicket,
    ttlSeconds: number,
  ): Promise<void> {
    await redis.set(onboardingTicket(tokenHash), JSON.stringify(ticket), 'EX', ttlSeconds);
  }

  async takeOnboardingTicket(tokenHash: string): Promise<OnboardingTicket | null> {
    // Atomic GET + DEL via MULTI (GETDEL needs Redis 6.2+).
    const k = onboardingTicket(tokenHash);
    const res = await redis.multi().get(k).del(k).exec();
    const raw = res?.[0]?.[1];
    return typeof raw === 'string' ? (JSON.parse(raw) as OnboardingTicket) : null;
  }
}
