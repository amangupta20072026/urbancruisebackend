/**
 * ==============================================================================
 * ICaptchaVerifier — port for CAPTCHA token verification
 * ==============================================================================
 * Used by sendOtp to enforce the post-lockout CAPTCHA gate (audit fix #10):
 * after a number trips the OTP brute-force lock, mobile_registry marks it
 * `captcha_required_until`, and while that window is open /otp/request must
 * carry a valid CAPTCHA token.
 *
 * IMPLEMENTATIONS
 *   HCaptchaVerifier         — calls hCaptcha's siteverify API (production)
 *   DisabledCaptchaVerifier  — gate OFF (HCAPTCHA_SECRET not configured)
 *   tests                    — any object implementing this interface
 * ==============================================================================
 */

export type CaptchaVerdict =
  /** Token is valid. */
  | { ok: true }
  /** Token was rejected by the provider (wrong, expired, reused, wrong site). */
  | { ok: false; reason: 'invalid'; providerCodes: string[] }
  /** The provider could not be reached / answered garbage. */
  | { ok: false; reason: 'unavailable' };

export interface ICaptchaVerifier {
  /** False when the gate is switched off (no secret configured). */
  readonly enabled: boolean;

  /** Verify one token. Never throws — every outcome is returned as data. */
  verify(token: string, remoteIp: string | null): Promise<CaptchaVerdict>;
}
