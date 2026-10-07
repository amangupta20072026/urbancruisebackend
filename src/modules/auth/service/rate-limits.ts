/**
 * ==============================================================================
 * auth.service — OTP send rate limits (atomic reserve-first)
 * ==============================================================================
 * Two exported entry points:
 *
 *   reserveSendQuota(store, mobile, ip, isTest[, policy])
 *     Called BEFORE an OTP is generated or any SMS is sent. Atomically claims
 *     the cooldown and increments every bucket, then compares the
 *     POST-increment values against the caps. Throws RateLimitError (with
 *     retryAfter) the moment any bucket is over. Returns the IP-block key
 *     that was charged (null if none) — the caller stores it in the OTP
 *     session so a later verify can be credited to the same block.
 *
 *   refundSendQuota(store, mobile, ipBlock)
 *     Called ONLY when the provider definitively failed to send. Releases the
 *     cooldown and gives back one unit of the per-mobile buckets so a real
 *     user is not locked out by an MSG91 outage they did not cause, and marks
 *     the send as failed in the IP-block window (conversion denominator).
 *
 * WHY RESERVE-FIRST (security fix — audit item #1):
 *   The previous design read the counters, sent the SMS, and only THEN
 *   incremented. N parallel requests all read the same under-cap values and
 *   all passed — 25 parallel requests produced 25 SMS to one number despite
 *   the 30 s cooldown (SMS bombing + MSG91 wallet drain).
 *
 *   Now:
 *     • the cooldown is a SET NX — exactly ONE request per window wins it;
 *     • each counter is an atomic INCR whose returned value is compared, so
 *       parallel requests receive distinct values 1..N and only those within
 *       the cap pass.
 *   A rejected attempt still consumes quota. That is intentional: it is what
 *   stops attackers from probing for free.
 *
 * Bucket layout:
 *   per-mobile:  cooldown, 10-minute, daily
 *   per-network: /24 (IPv4) or /64 (IPv6) hourly    ← anti SMS-pumping,
 *                soft cap + conversion check + hard cap (finding M4 —
 *                see ip-block-guard.ts)
 *   per-prefix:  first-5 chars of mobile, hourly    ← anti SMS-pumping
 *
 * User-facing messages for the anti-pumping caps are DELIBERATELY generic
 * ("your network" / "this number range") so we don't leak the bucket
 * identity to a probing attacker.
 * ==============================================================================
 */
import type { IOtpSessionStore } from '../ports/IOtpSessionStore.js';
import {
  OTP_SEND_MIN_INTERVAL_SECONDS,
  OTP_SEND_MAX_PER_10M,
  OTP_SEND_MAX_PER_DAY,
  OTP_SEND_MAX_PER_PREFIX_PER_HOUR,
} from '../../../config/constants.js';
import { ENV } from '../../../config/env.js';
import { RateLimitError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';
import { bucketIp } from '../../../shared/utils/ip-bucket.js';
import { bucketPrefix } from '../../../shared/utils/phone.js';
import { decideIpBlock, ipFamilyOf, isAlarmTick, type IpBlockPolicy } from './ip-block-guard.js';

/** Production policy, read once from validated ENV (finding M4). */
export const IP_BLOCK_POLICY: IpBlockPolicy = Object.freeze({
  v4: {
    softCap: ENV.OTP_IPV4_BLOCK_SOFT_CAP_PER_HOUR,
    hardCap: ENV.OTP_IPV4_BLOCK_HARD_CAP_PER_HOUR,
  },
  v6: {
    softCap: ENV.OTP_IPV6_BLOCK_SOFT_CAP_PER_HOUR,
    hardCap: ENV.OTP_IPV6_BLOCK_HARD_CAP_PER_HOUR,
  },
  minConversion: ENV.OTP_IP_BLOCK_MIN_CONVERSION,
});

export type ReservedQuota = {
  /** IP-block key charged for this send, or null (test mobile / no IP). */
  ipBlock: string | null;
};

/* ==============================================================================
 * RESERVE — atomic claim; throws when any bucket is over cap
 * ============================================================================== */

export async function reserveSendQuota(
  store: IOtpSessionStore,
  mobile: string,
  ip: string | null,
  isTest: boolean,
  policy: IpBlockPolicy = IP_BLOCK_POLICY,
): Promise<ReservedQuota> {
  // 1. Cooldown — SET NX: only one request per window gets through.
  const now = Date.now();
  const acquired = await store.tryAcquireSendCooldown(mobile, now, OTP_SEND_MIN_INTERVAL_SECONDS);
  if (!acquired) {
    const lastMs = await store.getLastSentAt(mobile);
    const elapsed = lastMs !== null ? (now - lastMs) / 1000 : 0;
    const retryAfter = Math.max(1, Math.ceil(OTP_SEND_MIN_INTERVAL_SECONDS - elapsed));
    throw new RateLimitError('Please wait before requesting another code.', 'send_cooldown', {
      retryAfter,
    });
  }

  // 2. 10-minute window (post-increment compare)
  const c10 = await store.incrementSendCount10m(mobile);
  if (c10 > OTP_SEND_MAX_PER_10M) {
    throw new RateLimitError(
      'Too many requests for this number. Wait a few minutes.',
      'send_limit_10m',
      { retryAfter: 600 },
    );
  }

  // 3. Daily
  const cd = await store.incrementSendCountDay(mobile);
  if (cd > OTP_SEND_MAX_PER_DAY) {
    throw new RateLimitError('Daily OTP limit reached for this number.', 'send_limit_day', {
      retryAfter: 86_400,
    });
  }

  /* ------------------------------------------------------------------
   * 4. SMS-pumping defenses (subnet + number-prefix).
   *
   * Skipped for test-mobile paths — QA tooling must never trip anti-
   * abuse limits and cause a test suite to silently degrade to 429s.
   * ------------------------------------------------------------------ */
  if (isTest) return { ipBlock: null };

  const ipKey = bucketIp(ip);
  if (ipKey) {
    await enforceIpBlock(store, ipKey, policy);
  }

  const prefixKey = bucketPrefix(mobile);
  const prefixCount = await store.incrementSendCountPrefix(prefixKey);
  if (prefixCount > OTP_SEND_MAX_PER_PREFIX_PER_HOUR) {
    logger.warn(
      {
        alarm: 'otp_prefix_limit',
        prefix: prefixKey,
        count: prefixCount,
        threshold: OTP_SEND_MAX_PER_PREFIX_PER_HOUR,
      },
      'otp send: per-number-prefix hourly cap tripped — possible SMS pumping targeting this range',
    );
    throw new RateLimitError(
      'Too many requests for this number range. Please try again later.',
      'send_limit_number_prefix',
      { retryAfter: 3600 },
    );
  }

  return { ipBlock: ipKey };
}

/* ==============================================================================
 * IP-BLOCK — soft cap + conversion + hard cap (finding M4)
 * ============================================================================== */

async function enforceIpBlock(
  store: IOtpSessionStore,
  ipKey: string,
  policy: IpBlockPolicy,
): Promise<void> {
  const family = ipFamilyOf(ipKey);
  const caps = policy[family];
  const w = await store.recordIpBlockSend(ipKey);
  const decision = decideIpBlock(w, caps, policy.minConversion);

  const base = {
    ipBlock: ipKey,
    family,
    sends: w.sends,
    verifies: w.verifies,
    failures: w.failures,
    softCap: caps.softCap,
    hardCap: caps.hardCap,
    minConversion: policy.minConversion,
  };

  switch (decision.outcome) {
    case 'allow':
      return;

    case 'allow_over_soft_cap':
      // Busy but healthy network (typically carrier CGNAT). Visible to ops
      // so caps can be tuned with real data; NOT a user-facing error.
      if (isAlarmTick(w.sends, caps.softCap)) {
        logger.info(
          { alarm: 'otp_ip_block_soft', ...base, conversion: round2(decision.conversion) },
          'otp send: IP block above soft cap but OTPs are being verified — allowed',
        );
      }
      return;

    case 'block_low_conversion':
      if (isAlarmTick(w.sends, caps.softCap)) {
        logger.warn(
          {
            alarm: 'otp_ip_block_limit',
            reason: 'low_conversion',
            ...base,
            conversion: round2(decision.conversion),
          },
          'otp send: IP block above soft cap with low OTP conversion — possible SMS pumping',
        );
      }
      throw ipBlockError(decision.retryAfter);

    case 'block_hard_cap':
      if (isAlarmTick(w.sends, caps.hardCap)) {
        logger.warn(
          { alarm: 'otp_ip_block_limit', reason: 'hard_cap', ...base },
          'otp send: IP block hit the hard hourly cap — refusing regardless of conversion',
        );
      }
      throw ipBlockError(decision.retryAfter);
  }
}

/** Same code + generic message for both block reasons, so a probing
 *  attacker learns nothing about which rule (or which bucket) fired. */
function ipBlockError(retryAfter: number): RateLimitError {
  return new RateLimitError(
    'Too many requests from your network. Please try again later.',
    'send_limit_ip_block',
    { retryAfter },
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ==============================================================================
 * REFUND — only after a definitive provider failure
 * ============================================================================== */

/**
 * Gives back the cooldown and one unit of the per-mobile buckets. The anti-
 * pumping buckets (IP block, prefix) are NOT refunded: they are high-volume
 * abuse caps and refunding them would let an attacker who can induce
 * provider errors run them indefinitely. The IP block does record the
 * failure, which only removes it from the CONVERSION denominator — the hard
 * cap still counts the send.
 *
 * Best-effort: a refund failure is logged, never surfaced — the user already
 * gets the real dispatch error.
 */
export async function refundSendQuota(
  store: IOtpSessionStore,
  mobile: string,
  ipBlock: string | null,
): Promise<void> {
  try {
    await Promise.all([
      store.releaseSendCooldown(mobile),
      store.refundSendCounts(mobile),
      ipBlock ? store.recordIpBlockSendFailure(ipBlock) : Promise.resolve(),
    ]);
  } catch (err) {
    logger.error({ err }, 'otp send: quota refund after provider failure did not complete');
  }
}
