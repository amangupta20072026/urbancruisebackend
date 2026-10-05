/**
 * ==============================================================================
 * auth.service — OTP send rate limits (atomic reserve-first)
 * ==============================================================================
 * Two exported entry points:
 *
 *   reserveSendQuota(store, mobile, ip, isTest)
 *     Called BEFORE an OTP is generated or any SMS is sent. Atomically claims
 *     the cooldown and increments every bucket, then compares the
 *     POST-increment values against the caps. Throws RateLimitError (with
 *     retryAfter) the moment any bucket is over.
 *
 *   refundSendQuota(store, mobile)
 *     Called ONLY when the provider definitively failed to send. Releases the
 *     cooldown and gives back one unit of the per-mobile buckets so a real
 *     user is not locked out by an MSG91 outage they did not cause.
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
 *   per-network: /24 (IPv4) or /64 (IPv6) hourly    ← anti SMS-pumping
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
  OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR,
  OTP_SEND_MAX_PER_PREFIX_PER_HOUR,
} from '../../../config/constants.js';
import { RateLimitError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';
import { bucketIp } from '../../../shared/utils/ip-bucket.js';
import { bucketPrefix } from '../../../shared/utils/phone.js';

/* ==============================================================================
 * RESERVE — atomic claim; throws when any bucket is over cap
 * ============================================================================== */

export async function reserveSendQuota(
  store: IOtpSessionStore,
  mobile: string,
  ip: string | null,
  isTest: boolean,
): Promise<void> {
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
  if (isTest) return;

  const ipKey = bucketIp(ip);
  if (ipKey) {
    const count = await store.incrementSendCountIpBlock(ipKey);
    if (count > OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR) {
      logger.warn(
        {
          alarm: 'otp_ip_block_limit',
          ipBlock: ipKey,
          count,
          threshold: OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR,
        },
        'otp send: per-IP-block hourly cap tripped — possible SMS pumping from this subnet',
      );
      throw new RateLimitError(
        'Too many requests from your network. Please try again later.',
        'send_limit_ip_block',
        { retryAfter: 3600 },
      );
    }
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
}

/* ==============================================================================
 * REFUND — only after a definitive provider failure
 * ============================================================================== */

/**
 * Gives back the cooldown and one unit of the per-mobile buckets. The anti-
 * pumping buckets (IP block, prefix) are NOT refunded: they are high-volume
 * abuse caps and refunding them would let an attacker who can induce
 * provider errors run them indefinitely.
 *
 * Best-effort: a refund failure is logged, never surfaced — the user already
 * gets the real dispatch error.
 */
export async function refundSendQuota(store: IOtpSessionStore, mobile: string): Promise<void> {
  try {
    await Promise.all([store.releaseSendCooldown(mobile), store.refundSendCounts(mobile)]);
  } catch (err) {
    logger.error({ err }, 'otp send: quota refund after provider failure did not complete');
  }
}
