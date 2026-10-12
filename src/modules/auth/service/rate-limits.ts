/**
 * OTP send rate limits, reserve-first: every bucket is claimed atomically
 * before any OTP is generated or SMS sent, and the post-increment value is
 * compared. Never read-then-increment: parallel requests would all pass.
 * Rejected attempts still use quota, so probing isn't free.
 *
 * Buckets: per mobile (cooldown, 10 minutes, day), per network (see
 * ip-block-guard.ts) and per number prefix (hourly). The network and prefix
 * caps are anti-pumping and use deliberately vague messages.
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

/** Production IP-block policy from ENV. */
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
  /** IP block charged, or null (test mobile or no IP). Stored on the OTP session. */
  ipBlock: string | null;
};

/** Claims quota for one send. Throws RateLimitError (with retryAfter) when any bucket is over. */
export async function reserveSendQuota(
  store: IOtpSessionStore,
  mobile: string,
  ip: string | null,
  isTest: boolean,
  policy: IpBlockPolicy = IP_BLOCK_POLICY,
): Promise<ReservedQuota> {
  // Cooldown: only one request per window wins.
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

  const c10 = await store.incrementSendCount10m(mobile);
  if (c10 > OTP_SEND_MAX_PER_10M) {
    throw new RateLimitError(
      'Too many requests for this number. Wait a few minutes.',
      'send_limit_10m',
      { retryAfter: 600 },
    );
  }

  const cd = await store.incrementSendCountDay(mobile);
  if (cd > OTP_SEND_MAX_PER_DAY) {
    throw new RateLimitError('Daily OTP limit reached for this number.', 'send_limit_day', {
      retryAfter: 86_400,
    });
  }

  // Anti-pumping caps. Test mobiles skip them so QA never hits 429s.
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
      // Busy but healthy network (often CGNAT). Logged for tuning, not refused.
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

/** One code and message for both block reasons, so probing reveals nothing. */
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

/**
 * After a definite provider failure: releases the cooldown and refunds the
 * per-mobile buckets, so an MSG91 outage doesn't lock users out. Anti-pumping
 * buckets aren't refunded (attackers could force provider errors); the IP
 * block only records the failure for its conversion rate.
 * Best-effort: errors are logged, not thrown.
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
