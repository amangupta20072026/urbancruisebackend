/**
 * ==============================================================================
 * auth.service — per-network (IP block) OTP guard  (finding M4)
 * ==============================================================================
 * PURE decision logic for the anti-SMS-pumping cap keyed by IPv4 /24 or
 * IPv6 /64. No Redis, no ENV, no logger — the caller supplies the window
 * counters and the policy, this file says allow / block. Unit-tested in
 * __tests__/ip-block-guard.test.ts.
 *
 * WHY NOT A SINGLE FLAT CAP (the M4 problem):
 *   Mobile carriers commonly use CGNAT: many subscribers share a small pool
 *   of public IPv4 addresses, so one /24 can front a large number of real
 *   users. A flat "100 OTPs / hour / /24" cannot tell a pumping bot from a
 *   busy carrier network, and would return 429 to genuine users for up to
 *   an hour.
 *
 * DESIGN PREMISE — conversion:
 *   Genuine users request an OTP in order to enter it; SMS pumping
 *   (IRSF / artificially-inflated traffic) targets numbers whose OTPs are
 *   not entered in the app. So a block's verify rate separates the two
 *   better than its raw volume. The guard counts, per block per hour:
 *     sends     — OTP send reservations from this block
 *     verifies  — successful verifications of OTPs SENT from this block
 *                 (credited to the send-side block stored in the OTP
 *                 session, so a phone changing IP between send and verify
 *                 still counts)
 *     failures  — sends the provider definitively failed (excluded from the
 *                 denominator so an MSG91 outage can't tank a block's rate)
 *
 * DECISION (separate caps per IP family, because an IPv4 /24 and an IPv6
 * /64 are different-sized buckets and are tuned independently):
 *
 *   sends ≤ softCap                       → allow  (not enough data to judge)
 *   sends > hardCap                       → BLOCK  (absolute ceiling — bounds
 *                                                   worst-case spend even if an
 *                                                   attacker fakes conversion)
 *   softCap < sends ≤ hardCap:
 *     conversion ≥ minConversion          → allow  (busy shared network — alarm
 *                                                   so ops can see it)
 *     conversion <  minConversion         → BLOCK  (looks like pumping)
 *
 *   conversion = verifies / max(1, sends − failures), clamped to [0, 1].
 *
 * minConversion should sit well BELOW the genuine conversion rate you see
 * in production: OTPs still in flight (sent, not yet typed) lower the
 * measured rate, and a borderline block should reach the hard cap rather
 * than lock real users out. The shipped defaults (see config/env.ts) are
 * STARTING VALUES, not measured ones — set them from your own otp_events
 * data and the otp_ip_block_soft / otp_ip_block_limit alarms.
 * ==============================================================================
 */
import type { IpBlockWindow } from '../ports/IOtpSessionStore.js';

export type { IpBlockWindow };

export type IpFamily = 'v4' | 'v6';

export type IpBlockCaps = {
  /** Sends per hour below which a block is always allowed. */
  softCap: number;
  /** Sends per hour above which a block is always refused. */
  hardCap: number;
};

export type IpBlockPolicy = {
  v4: IpBlockCaps;
  v6: IpBlockCaps;
  /** Minimum verified/delivered ratio required above the soft cap (0..1). */
  minConversion: number;
};

export type IpBlockDecision =
  | { outcome: 'allow' }
  | { outcome: 'allow_over_soft_cap'; conversion: number }
  | { outcome: 'block_hard_cap'; retryAfter: number }
  | { outcome: 'block_low_conversion'; conversion: number; retryAfter: number };

/**
 * A low-conversion block can recover (other users in the block verify), so
 * we tell the client to retry sooner than the full window. A hard-cap block
 * cannot recover until the window expires.
 */
export const LOW_CONVERSION_MAX_RETRY_AFTER_SECONDS = 600;

/** Emit a repeat alarm every N sends past a threshold (first crossing always). */
export const IP_BLOCK_ALARM_EVERY = 100;

/** Bucket keys from shared/utils/ip-bucket.ts are "v4:a.b.c" or "v6:xxxx:…". */
export function ipFamilyOf(ipBlockKey: string): IpFamily {
  return ipBlockKey.startsWith('v6:') ? 'v6' : 'v4';
}

export function conversionRate(w: Pick<IpBlockWindow, 'sends' | 'verifies' | 'failures'>): number {
  const delivered = Math.max(1, w.sends - w.failures);
  return Math.min(1, Math.max(0, w.verifies / delivered));
}

export function decideIpBlock(
  w: IpBlockWindow,
  caps: IpBlockCaps,
  minConversion: number,
): IpBlockDecision {
  const ttl = Math.max(1, Math.ceil(w.ttlSeconds));

  if (w.sends > caps.hardCap) {
    return { outcome: 'block_hard_cap', retryAfter: ttl };
  }
  if (w.sends <= caps.softCap) {
    return { outcome: 'allow' };
  }

  const conversion = conversionRate(w);
  if (conversion >= minConversion) {
    return { outcome: 'allow_over_soft_cap', conversion };
  }
  return {
    outcome: 'block_low_conversion',
    conversion,
    retryAfter: Math.min(ttl, LOW_CONVERSION_MAX_RETRY_AFTER_SECONDS),
  };
}

/**
 * Throttles alarm logs so an attack running at thousands of requests/hour
 * produces a handful of log lines, not thousands: fire on the first send
 * past `threshold`, then every IP_BLOCK_ALARM_EVERY sends after that.
 */
export function isAlarmTick(sends: number, threshold: number): boolean {
  if (sends <= threshold) return false;
  const past = sends - threshold;
  return past === 1 || past % IP_BLOCK_ALARM_EVERY === 0;
}
