/**
 * ==============================================================================
 * MSG91 OTP dispatch — server-owned OTP over WhatsApp with SMS fallback
 * ==============================================================================
 * WE generate the OTP (crypto.randomInt) and pass it to MSG91 as a template
 * parameter. MSG91 is JUST the message transport — no MSG91-managed OTP
 * state. This gives us full server-side control of retries, rate limits,
 * brute-force locks, and test mode.
 *
 * TEMPLATE CONTRACT:
 *   WhatsApp — MSG91_WA_TEMPLATE_NAME must be pre-approved with ONE
 *              body variable in slot {{1}}: the OTP.
 *   SMS      — MSG91_SMS_TEMPLATE_ID must have the OTP as ##OTP##.
 *
 * FALLBACK RULES (per failure matrix):
 *   • MSG91 returns phone_not_wa (Meta 131026) → SMS retry with the SAME OTP.
 *   • MSG91 returns waba_suspended             → SMS immediately.
 *   • MSG91 returns wallet_low                 → don't fall back, surface error.
 *   • MSG91 returns rate_limited               → don't fall back, surface error.
 *   • Timeout / network                        → SMS retry once.
 *
 * Fallback happens INSIDE this file — callers see one function that either
 * succeeds (with channel: 'whatsapp' | 'sms') or fails.
 * ==============================================================================
 */
import { msg91Client } from './client.js';
import { parseMsg91Response, parseMsg91Error, type Msg91Outcome } from './errors.js';
import { ENV } from '../../../config/env.js';
import { logger } from '../../logger/index.js';

export type Msg91DispatchResult = {
  /** True when the message was accepted by MSG91 (delivery is async). */
  ok: boolean;
  /** Actual channel used — 'sms' means WhatsApp fell back. */
  channel: 'whatsapp' | 'sms';
  /** MSG91's request ID (echoed in delivery webhook). Undefined on hard fail. */
  providerRequestId?: string;
  /** Internal failure outcome when ok=false. */
  failure?: Msg91Outcome;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Send `otp` to `mobile` via WhatsApp; auto-fall-back to SMS on
 * phone_not_wa / waba_suspended / timeout / network.
 *
 * `mobile` MUST be in E.164 without '+' (e.g. '919812345678').
 */
export async function dispatchOtp(mobile: string, otp: string): Promise<Msg91DispatchResult> {
  const wa = await sendWhatsApp(mobile, otp);
  if (wa.ok) return wa;

  // Decide whether to fall back or bubble up.
  const shouldFallback =
    wa.failure === 'phone_not_wa' ||
    wa.failure === 'waba_suspended' ||
    wa.failure === 'timeout' ||
    wa.failure === 'network';

  if (!shouldFallback) return wa;

  logger.warn(
    { mobile: maskMobile(mobile), reason: wa.failure, code: wa.errorCode },
    'msg91 whatsapp failed — falling back to SMS',
  );

  return sendSms(mobile, otp);
}

/* -----------------------------------------------------------------
 * WhatsApp — MSG91 Integration API v5
 * ----------------------------------------------------------------- */

async function sendWhatsApp(mobile: string, otp: string): Promise<Msg91DispatchResult> {
  // MSG91 WhatsApp payload shape.
  // Ref: https://docs.msg91.com/whatsapp/whatsapp-api
  const payload = {
    integrated_number: ENV.MSG91_WA_INTEGRATED_NUMBER,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: ENV.MSG91_WA_TEMPLATE_NAME,
        language: { code: 'en', policy: 'deterministic' },
        namespace: null,
        to_and_components: [
          {
            to: [mobile],
            components: {
              // {{1}} in the approved template body
              body_1: { type: 'text', value: otp },
            },
          },
        ],
      },
    },
  };

  try {
    const res = await msg91Client.post('/v5/whatsapp/whatsapp-outbound-message/bulk/', payload);
    const parsed = parseMsg91Response(res);

    if (parsed.outcome === 'success') {
      return {
        ok: true,
        channel: 'whatsapp',
        ...(parsed.requestId ? { providerRequestId: parsed.requestId } : {}),
      };
    }
    return {
      ok: false,
      channel: 'whatsapp',
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  } catch (err) {
    const parsed = parseMsg91Error(err);
    return {
      ok: false,
      channel: 'whatsapp',
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  }
}

/* -----------------------------------------------------------------
 * SMS — MSG91 Flow API (transactional route with pre-approved template)
 * ----------------------------------------------------------------- */

async function sendSms(mobile: string, otp: string): Promise<Msg91DispatchResult> {
  const payload = {
    template_id: ENV.MSG91_SMS_TEMPLATE_ID,
    sender: ENV.MSG91_SMS_SENDER_ID,
    short_url: '0',
    mobiles: mobile,
    OTP: otp, // matches ##OTP## variable in the SMS template
  };

  try {
    const res = await msg91Client.post('/v5/flow/', payload);
    const parsed = parseMsg91Response(res);

    if (parsed.outcome === 'success') {
      return {
        ok: true,
        channel: 'sms',
        ...(parsed.requestId ? { providerRequestId: parsed.requestId } : {}),
      };
    }
    return {
      ok: false,
      channel: 'sms',
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  } catch (err) {
    const parsed = parseMsg91Error(err);
    return {
      ok: false,
      channel: 'sms',
      failure: parsed.outcome,
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    };
  }
}

/* -----------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------- */

/** Log-safe mobile — first 4 + last 2 digits, everything else '*'. */
function maskMobile(mobile: string): string {
  if (mobile.length < 8) return '****';
  return `${mobile.slice(0, 4)}****${mobile.slice(-2)}`;
}
