/**
 * Port for CAPTCHA verification. While a number is in its post-lockout
 * window (mobile_registry.captcha_required_until), /otp/request needs a
 * valid token. Implementations: HCaptchaVerifier, DisabledCaptchaVerifier.
 */

export type CaptchaVerdict =
  /** Token is valid. */
  | { ok: true }
  /** Rejected (wrong, expired, reused, or for another site). */
  | { ok: false; reason: 'invalid'; providerCodes: string[] }
  /** Provider unreachable or gave an unusable answer. */
  | { ok: false; reason: 'unavailable' };

export interface ICaptchaVerifier {
  /** False when no secret is configured (gate off). */
  readonly enabled: boolean;

  /** Never throws; every outcome is returned as a verdict. */
  verify(token: string, remoteIp: string | null): Promise<CaptchaVerdict>;
}
