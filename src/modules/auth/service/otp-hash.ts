/**
 * OTP hashing. A 6-digit code has only a million values, so a plain hash is
 * trivially reversible if Redis leaks. We store an HMAC keyed by a server
 * secret and bound to the requestId, so it can't be reversed or replayed.
 */
import { ENV } from '../../../config/env.js';
import { hmacSha256, sha256 } from '../../../shared/utils/crypto.js';

/** Derived key, so the JWT secret isn't reused directly. */
const OTP_HMAC_KEY = sha256(`urbancruise:otp-hmac:v1:${ENV.JWT_ACCESS_SECRET}`);

export function hashOtp(requestId: string, otp: string): string {
  return hmacSha256(OTP_HMAC_KEY, `${requestId}:${otp}`);
}
