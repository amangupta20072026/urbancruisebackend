/**
 * ==============================================================================
 * MSG91 OTP dispatch — server-owned OTP over SMS (Flow API v5)
 * ==============================================================================
 * WE generate the OTP (crypto.randomInt in the auth service) and pass it to
 * MSG91 as a template variable. MSG91 is JUST the message transport — no
 * MSG91-managed OTP state. This gives us full server-side control of retries,
 * rate limits, brute-force locks, and test mode, and keeps verify latency at
 * Redis speed rather than MSG91-roundtrip speed.
 *
 * RELIABILITY LAYERS (in call order):
 *   1. Circuit breaker (Redis) — if MSG91 has failed too often recently,
 *      short-circuit with `circuit_open` so we don't burn 8s per request
 *      waiting for a timeout that will fail anyway. Test-mobile sends
 *      never reach this file so are never affected.
 *   2. First HTTP attempt (8s timeout).
 *   3. On TRANSIENT failure (`timeout | network | provider_server_error`),
 *      one backoff-delayed retry with the SAME OTP value.
 *   4. Book-keeping: success → clear the failure counter; failure → increment
 *      it and, if it crosses the threshold, open the circuit for 60s.
 *
 * TEMPLATE CONTRACT (configured in MSG91 dashboard, DLT-approved for India):
 *   MSG91_SMS_TEMPLATE_ID must expose the OTP as the ##OTP## variable.
 *   MSG91_SMS_SENDER_ID must be the pre-approved 6-char alpha sender.
 *
 * REFERENCE (official):
 *   https://api.msg91.com/apidoc/textsms/send-sms-flow.php
 *
 * ROADMAP:
 *   When email OTP lands, add a sibling `dispatchEmailOtp()` (or a channel-
 *   aware `dispatchOtp({ channel, target, otp })`). This file's contract —
 *   returns a `ProviderResult`-shaped object — stays the audit / retry
 *   surface for every channel. The circuit breaker should stay per-channel
 *   (SMS breaker open doesn't imply email is broken).
 * ==============================================================================
 */
import { msg91Client } from './client.js';
import { parseMsg91Response, parseMsg91Error, type ProviderOutcome } from './errors.js';
import { ENV } from '../../../config/env.js';
import {
  MSG91_MAX_RETRIES,
  MSG91_RETRY_DELAY_MS,
  MSG91_CB_FAILURE_THRESHOLD,
  MSG91_CB_WINDOW_SECONDS,
  MSG91_CB_OPEN_SECONDS,
} from '../../../config/constants.js';
import { redis } from '../../redis/client.js';
import { circuitBreakerMsg91Sms } from '../../redis/keys.js';
import { logger } from '../../logger/index.js';

/** Circuit-breaker Redis keys — derived from the registry base. */
const CB_STATE_KEY = `${circuitBreakerMsg91Sms()}:open`;
const CB_FAILURES_KEY = `${circuitBreakerMsg91Sms()}:failures`;

/** Outcomes considered safe to retry once. Everything else surfaces first-hit. */
const RETRYABLE: ReadonlySet<ProviderOutcome> = new Set<ProviderOutcome>([
  'timeout',
  'network',
  'provider_server_error',
]);

export type OtpDispatchResult = {
  /** True when the message was accepted by MSG91 (delivery is async). */
  ok: boolean;
  /** MSG91's request ID (echoed in delivery webhook). Undefined on hard fail. */
  providerRequestId?: string;
  /** Internal failure outcome when ok=false. */
  failure?: ProviderOutcome | 'circuit_open';
  /**
   * How many HTTP attempts were made against MSG91 for this dispatch.
   * 1 = happy path, 2 = retried once, 0 = circuit was open (no attempt made).
   */
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * @deprecated Kept as an alias while callers migrate to `OtpDispatchResult`.
 */
export type Msg91DispatchResult = OtpDispatchResult;

/**
 * Send `otp` to `mobile` via MSG91 Flow API (transactional SMS route),
 * with a single-attempt retry for transient failures and a Redis-backed
 * circuit breaker on top.
 *
 * `mobile` MUST be in E.164 without '+' (e.g. '919812345678').
 * `otp` is the plaintext code as it should appear in the SMS.
 *
 * The function never throws for provider-level failures — every outcome
 * (success or classified failure) is returned as data so the caller can
 * decide how to surface / audit it. Only programmer errors (bad env, etc.)
 * would bubble up.
 */
export async function dispatchOtp(mobile: string, otp: string): Promise<OtpDispatchResult> {
  // 1. Circuit breaker check — fail fast if MSG91 has been down.
  if (await isCircuitOpen()) {
    return {
      ok: false,
      failure: 'circuit_open',
      attempts: 0,
      errorMessage: 'OTP provider circuit breaker is open.',
    };
  }

  // 2. First attempt.
  let attempts = 1;
  let result = await sendSms(mobile, otp);

  // 3. Retry once on transient failures.
  if (!result.ok && result.failure && RETRYABLE.has(result.failure as ProviderOutcome)) {
    for (let i = 0; i < MSG91_MAX_RETRIES; i += 1) {
      await sleep(MSG91_RETRY_DELAY_MS);
      attempts += 1;
      result = await sendSms(mobile, otp);
      if (result.ok || !result.failure || !RETRYABLE.has(result.failure as ProviderOutcome)) {
        break;
      }
    }
  }

  // 4. Book-keeping. Any final failure counts as ONE logical failure
  //    (a two-attempt burst is still one bad dispatch from the breaker's
  //    view). Success clears the counter but never touches an already-open
  //    circuit — that opens key expires naturally to give real MSG91
  //    recovery time.
  if (result.ok) {
    await resetCircuitFailures();
  } else {
    await recordCircuitFailure();
  }

  return { ...result, attempts };
}

/* -----------------------------------------------------------------
 * SMS — MSG91 Flow API v5 (transactional route with DLT template)
 * ----------------------------------------------------------------- */

async function sendSms(mobile: string, otp: string): Promise<Omit<OtpDispatchResult, 'attempts'>> {
  // Payload shape per MSG91 Flow API v5 docs.
  // `OTP` (upper-case) is the template variable name — must match the
  // approved template's placeholder (##OTP##).
  const payload = {
    template_id: ENV.MSG91_SMS_TEMPLATE_ID,
    sender: ENV.MSG91_SMS_SENDER_ID,
    short_url: '0',
    mobiles: mobile,
    OTP: otp,
  };

  try {
    const res = await msg91Client.post('/v5/flow/', payload);
    const parsed = parseMsg91Response(res);

    if (parsed.outcome === 'success') {
      return {
        ok: true,
        ...(parsed.requestId ? { providerRequestId: parsed.requestId } : {}),
      };
    }
    return {
      ok: false,
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  } catch (err) {
    const parsed = parseMsg91Error(err);
    return {
      ok: false,
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  }
}

/* -----------------------------------------------------------------
 * Circuit breaker (Redis-backed)
 * -----------------------------------------------------------------
 * Two keys:
 *   cb:msg91:sms:open      — presence => circuit is open, TTL = 60s
 *   cb:msg91:sms:failures  — counter of recent failures, TTL = 300s
 *
 * We never touch cb:msg91:sms:failures once the circuit is open. When the
 * open key expires, the next request naturally probes MSG91: success clears
 * the failure counter and the world moves on; failure re-increments and
 * re-trips the breaker if the threshold is met again.
 * ----------------------------------------------------------------- */

async function isCircuitOpen(): Promise<boolean> {
  try {
    return (await redis.exists(CB_STATE_KEY)) === 1;
  } catch (err) {
    // Redis is down — do NOT block MSG91 sends over infrastructure noise.
    // Log and let the request through; if MSG91 is fine the user still
    // gets their OTP. If Redis is down and MSG91 is also down, the request
    // will just fail per usual with `network`/`timeout`.
    logger.error({ err }, 'circuit breaker: redis EXISTS failed, allowing send through');
    return false;
  }
}

async function resetCircuitFailures(): Promise<void> {
  try {
    await redis.del(CB_FAILURES_KEY);
  } catch (err) {
    logger.error({ err }, 'circuit breaker: redis DEL failures failed');
  }
}

async function recordCircuitFailure(): Promise<void> {
  try {
    const n = await redis.incr(CB_FAILURES_KEY);
    if (n === 1) {
      await redis.expire(CB_FAILURES_KEY, MSG91_CB_WINDOW_SECONDS);
    }
    if (n >= MSG91_CB_FAILURE_THRESHOLD) {
      // Trip the breaker and reset the counter so the next window is fresh.
      // A one-shot SET NX-less write is fine: two racing writers just set
      // the same key twice, which is idempotent.
      await Promise.all([
        redis.set(CB_STATE_KEY, '1', 'EX', MSG91_CB_OPEN_SECONDS),
        redis.del(CB_FAILURES_KEY),
      ]);
      logger.fatal(
        {
          alarm: 'msg91_circuit_open',
          threshold: MSG91_CB_FAILURE_THRESHOLD,
          openForSeconds: MSG91_CB_OPEN_SECONDS,
        },
        'msg91 circuit breaker OPENED — sends will short-circuit until recovery window elapses',
      );
    }
  } catch (err) {
    // Redis down — the breaker is a best-effort optimisation, not a
    // correctness guarantee. Auth still functions without it.
    logger.error({ err }, 'circuit breaker: redis INCR/SET failed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
