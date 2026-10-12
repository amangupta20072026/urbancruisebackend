/**
 * Per-network OTP guard against SMS pumping, keyed by IPv4 /24 or IPv6 /64.
 * Pure logic: the caller supplies the hourly counters and policy.
 *
 * A flat cap would block busy carrier CGNAT ranges, so the guard also uses
 * conversion: real users type their OTP, pumped numbers don't.
 *   sends ≤ softCap                → allow
 *   sends > hardCap                → block (bounds spend even if conversion is faked)
 *   in between, conversion ≥ min   → allow, with an alarm
 *   in between, conversion < min   → block
 * conversion = verifies / max(1, sends − failures). Verifies are credited to
 * the block the OTP was sent from; provider failures don't count against it.
 * Keep minConversion well below the real rate (in-flight OTPs lower it).
 * The env defaults are starting values; tune them from otp_events and the
 * otp_ip_block_soft / otp_ip_block_limit alarms.
 */
import type { IpBlockWindow } from '../ports/IOtpSessionStore.js';

export type { IpBlockWindow };

export type IpFamily = 'v4' | 'v6';

export type IpBlockCaps = {
  /** At or below this many sends per hour: always allowed. */
  softCap: number;
  /** Above this many sends per hour: always refused. */
  hardCap: number;
};

export type IpBlockPolicy = {
  v4: IpBlockCaps;
  v6: IpBlockCaps;
  /** Minimum verified/delivered ratio above the soft cap (0..1). */
  minConversion: number;
};

export type IpBlockDecision =
  | { outcome: 'allow' }
  | { outcome: 'allow_over_soft_cap'; conversion: number }
  | { outcome: 'block_hard_cap'; retryAfter: number }
  | { outcome: 'block_low_conversion'; conversion: number; retryAfter: number };

/** Low conversion can recover within the window, so it gets a shorter Retry-After. */
export const LOW_CONVERSION_MAX_RETRY_AFTER_SECONDS = 600;

/** Alarm on the first send past a threshold, then every N sends. */
export const IP_BLOCK_ALARM_EVERY = 100;

/** Keys from shared/utils/ip-bucket.ts look like "v4:a.b.c" or "v6:xxxx:…". */
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

/** Throttles alarm logs so an attack produces a few lines, not thousands. */
export function isAlarmTick(sends: number, threshold: number): boolean {
  if (sends <= threshold) return false;
  const past = sends - threshold;
  return past === 1 || past % IP_BLOCK_ALARM_EVERY === 0;
}
