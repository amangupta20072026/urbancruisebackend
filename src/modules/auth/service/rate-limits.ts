/**
 * ==============================================================================
 * auth.service — OTP send rate limits + counter maintenance
 * ==============================================================================
 * Two exported entry points:
 *
 *   enforceSendRateLimits(store, mobile, ip, isTest)
 *     Read-side check — throws RateLimitError (with retryAfter) the moment
 *     any bucket is over the cap. Called BEFORE we generate/store an OTP
 *     so a rate-limited request never gets a redis session or an SMS.
 *
 *   incrementSendCounters(store, mobile, ip, isTest)
 *     Write-side bump — called AFTER a successful (or silent-drop) send.
 *     Increments per-mobile 10m/day counters, sets last-sent timestamp, and
 *     bumps anti-pumping subnet + prefix buckets. Silent-drops go through
 *     this too so they still burn quota — that's what stops attackers from
 *     probing unprovisioned numbers for free.
 *
 * DESIGN CHANGE (DIP fix):
 *   Both functions now accept an IOtpSessionStore instead of importing the
 *   concrete redis singleton. This makes the rate-limit logic unit-testable
 *   with InMemoryOtpSessionStore — no Redis needed.
 *
 * Bucket layout:
 *   per-mobile:  cooldown, 10-minute, daily
 *   per-network: /24 (IPv4) or /64 (IPv6) hourly    ← anti SMS-pumping
 *   per-prefix:  first-5 chars of mobile, hourly    ← anti SMS-pumping
 *
 * User-facing error messages for the anti-pumping caps are DELIBERATELY
 * generic ("your network" / "this number range") so we don't leak the
 * bucket identity to a probing attacker.
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
 * READ SIDE — throws when any bucket is over cap
 * ============================================================================== */

export async function enforceSendRateLimits(
  store: IOtpSessionStore,
  mobile: string,
  ip: string | null,
  isTest: boolean,
): Promise<void> {
  // 1. Cooldown between sends
  const lastMs = await store.getLastSentAt(mobile);
  if (lastMs !== null) {
    const elapsed = (Date.now() - lastMs) / 1000;
    if (elapsed < OTP_SEND_MIN_INTERVAL_SECONDS) {
      const retryAfter = Math.ceil(OTP_SEND_MIN_INTERVAL_SECONDS - elapsed);
      throw new RateLimitError('Please wait before requesting another code.', 'send_cooldown', {
        retryAfter,
      });
    }
  }

  // 2. 10-minute window
  const c10 = await store.getSendCount10m(mobile);
  if (c10 >= OTP_SEND_MAX_PER_10M) {
    throw new RateLimitError(
      'Too many requests for this number. Wait a few minutes.',
      'send_limit_10m',
      { retryAfter: 600 },
    );
  }

  // 3. Daily
  const cd = await store.getSendCountDay(mobile);
  if (cd >= OTP_SEND_MAX_PER_DAY) {
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
    const count = await store.getSendCountIpBlock(ipKey);
    if (count >= OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR) {
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
  const prefixCount = await store.getSendCountPrefix(prefixKey);
  if (prefixCount >= OTP_SEND_MAX_PER_PREFIX_PER_HOUR) {
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
 * WRITE SIDE — bump every relevant counter after a successful/silent send
 * ============================================================================== */

export async function incrementSendCounters(
  store: IOtpSessionStore,
  mobile: string,
  ip: string | null,
  isTest: boolean,
): Promise<void> {
  const jobs: Promise<unknown>[] = [
    store.setLastSentAt(mobile, Date.now(), OTP_SEND_MIN_INTERVAL_SECONDS + 5),
    store.incrementSendCount10m(mobile),
    store.incrementSendCountDay(mobile),
  ];

  // Anti-pumping counters — test-mobile requests do not bump these.
  if (!isTest) {
    const ipKey = bucketIp(ip);
    if (ipKey) {
      jobs.push(store.incrementSendCountIpBlock(ipKey));
    }
    jobs.push(store.incrementSendCountPrefix(bucketPrefix(mobile)));
  }

  await Promise.all(jobs);
}
