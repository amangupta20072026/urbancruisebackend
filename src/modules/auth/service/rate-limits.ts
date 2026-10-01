/**
 * ==============================================================================
 * auth.service — OTP send rate limits + counter maintenance
 * ==============================================================================
 * Two exported entry points:
 *
 *   enforceSendRateLimits(mobile, ip, isTest)
 *     Read-side check — throws RateLimitError (with retryAfter) the moment
 *     any bucket is over the cap. Called BEFORE we generate/store an OTP
 *     so a rate-limited request never gets a redis session or an SMS.
 *
 *   incrementSendCounters(mobile, ip, isTest)
 *     Write-side bump — called AFTER a successful (or silent-drop) send.
 *     Increments per-mobile 10m/day counters, sets last-sent timestamp, and
 *     bumps anti-pumping subnet + prefix buckets. Silent-drops go through
 *     this too so they still burn quota — that's what stops attackers from
 *     probing unprovisioned numbers for free.
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
import { redis } from '../../../shared/redis/client.js';
import {
  otpLastSent,
  otpRateMobile10m,
  otpRateMobileDay,
  otpRateIpBlock,
  otpRateNumberPrefix,
} from '../../../shared/redis/keys.js';
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
 * READ SIDE — throws when any bucket is over
 * ============================================================================== */

export async function enforceSendRateLimits(
  mobile: string,
  ip: string | null,
  isTest: boolean,
): Promise<void> {
  // 1. Cooldown between sends
  const last = await redis.get(otpLastSent(mobile));
  if (last) {
    const elapsed = (Date.now() - Number(last)) / 1000;
    if (elapsed < OTP_SEND_MIN_INTERVAL_SECONDS) {
      const retryAfter = Math.ceil(OTP_SEND_MIN_INTERVAL_SECONDS - elapsed);
      throw new RateLimitError('Please wait before requesting another code.', 'send_cooldown', {
        retryAfter,
      });
    }
  }

  // 2. 10-minute window
  const c10 = await redis.get(otpRateMobile10m(mobile));
  if (c10 && Number(c10) >= OTP_SEND_MAX_PER_10M) {
    throw new RateLimitError(
      'Too many requests for this number. Wait a few minutes.',
      'send_limit_10m',
      { retryAfter: 600 },
    );
  }

  // 3. Daily
  const cd = await redis.get(otpRateMobileDay(mobile));
  if (cd && Number(cd) >= OTP_SEND_MAX_PER_DAY) {
    throw new RateLimitError('Daily OTP limit reached for this number.', 'send_limit_day', {
      retryAfter: 86_400,
    });
  }

  /* --------------------------------------------------------------
   * 4. SMS-pumping defenses (subnet + number-prefix).
   *
   * Skipped for test-mobile paths — QA tooling must never be able
   * to trip anti-abuse limits and cause a test suite to silently
   * degrade to 429s.
   *
   * These limits catch the shared attributes of pumping traffic
   * that per-mobile counters miss (attacker rotates the target
   * number, hitting a fresh per-mobile bucket every time).
   * -------------------------------------------------------------- */
  if (isTest) return;

  // Per-IP-block (IPv4 /24, IPv6 /64) hourly cap. Skipped only when we
  // couldn't parse a source IP at all (rare — trust-proxy is set).
  const ipKey = bucketIp(ip);
  if (ipKey) {
    const raw = await redis.get(otpRateIpBlock(ipKey));
    const count = raw ? Number(raw) : 0;
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

  // Per-number-prefix hourly cap. Always applicable — mobile is always
  // present at this point (validated upstream by Zod).
  const prefixKey = bucketPrefix(mobile);
  const raw = await redis.get(otpRateNumberPrefix(prefixKey));
  const count = raw ? Number(raw) : 0;
  if (count >= OTP_SEND_MAX_PER_PREFIX_PER_HOUR) {
    logger.warn(
      {
        alarm: 'otp_prefix_limit',
        prefix: prefixKey,
        count,
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
  mobile: string,
  ip: string | null,
  isTest: boolean,
): Promise<void> {
  const now = String(Date.now());
  const jobs: Promise<unknown>[] = [
    redis.set(otpLastSent(mobile), now, 'EX', OTP_SEND_MIN_INTERVAL_SECONDS + 5),
    (async () => {
      const k = otpRateMobile10m(mobile);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 600);
    })(),
    (async () => {
      const k = otpRateMobileDay(mobile);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 86_400);
    })(),
  ];

  // Anti-pumping counters — bump alongside the per-mobile ones so probes
  // burn the subnet + prefix quotas even when they rotate target numbers.
  // Silent-drop requests bump these too (they look identical to a real
  // send at the anti-abuse layer); test-mobile requests do not.
  if (!isTest) {
    const ipKey = bucketIp(ip);
    if (ipKey) {
      jobs.push(
        (async () => {
          const k = otpRateIpBlock(ipKey);
          const n = await redis.incr(k);
          if (n === 1) await redis.expire(k, 3600);
        })(),
      );
    }
    const prefixKey = bucketPrefix(mobile);
    jobs.push(
      (async () => {
        const k = otpRateNumberPrefix(prefixKey);
        const n = await redis.incr(k);
        if (n === 1) await redis.expire(k, 3600);
      })(),
    );
  }

  await Promise.all(jobs);
}
