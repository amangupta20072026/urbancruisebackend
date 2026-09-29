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
 *   surface for every channel.
 * ==============================================================================
 */
import { msg91Client } from './client.js';
import { parseMsg91Response, parseMsg91Error, type ProviderOutcome } from './errors.js';
import { ENV } from '../../../config/env.js';

export type OtpDispatchResult = {
  /** True when the message was accepted by MSG91 (delivery is async). */
  ok: boolean;
  /** MSG91's request ID (echoed in delivery webhook). Undefined on hard fail. */
  providerRequestId?: string;
  /** Internal failure outcome when ok=false. */
  failure?: ProviderOutcome;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * @deprecated Kept as an alias while callers migrate to `OtpDispatchResult`.
 */
export type Msg91DispatchResult = OtpDispatchResult;

/**
 * Send `otp` to `mobile` via MSG91 Flow API (transactional SMS route).
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
  return sendSms(mobile, otp);
}

/* -----------------------------------------------------------------
 * SMS — MSG91 Flow API v5 (transactional route with DLT template)
 * ----------------------------------------------------------------- */

async function sendSms(mobile: string, otp: string): Promise<OtpDispatchResult> {
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
