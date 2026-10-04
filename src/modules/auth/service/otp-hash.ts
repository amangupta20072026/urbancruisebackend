/**
 * ==============================================================================
 * auth.service — OTP hashing
 * ==============================================================================
 * A 6-digit OTP has only 1,000,000 possible values, so a plain sha256 stored
 * in Redis is reversible in milliseconds if Redis ever leaks. We store an
 * HMAC keyed with a server secret and bound to the requestId instead: without
 * the key the hash is useless, and a hash cannot be replayed across requests.
 * ==============================================================================
 */
import { ENV } from '../../../config/env.js';
import { hmacSha256, sha256 } from '../../../shared/utils/crypto.js';

/** Derived key — never use the JWT secret directly for a second purpose. */
const OTP_HMAC_KEY = sha256(`urbancruise:otp-hmac:v1:${ENV.JWT_ACCESS_SECRET}`);

export function hashOtp(requestId: string, otp: string): string {
  return hmacSha256(OTP_HMAC_KEY, `${requestId}:${otp}`);
}
