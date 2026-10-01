/**
 * ==============================================================================
 * Phone helpers — normalize, mask, bucket
 * ==============================================================================
 * The one true internal phone format is E.164 WITHOUT '+' (e.g. '919812345678').
 * Everything past this layer sees that shape; DB tables that store other
 * shapes are matched by candidate-format expansion in the repository, not here.
 *
 * Extracted from src/modules/auth/service.ts.
 * ==============================================================================
 */
import { OTP_PREFIX_LENGTH } from '../../config/constants.js';

/**
 * Client sends split `{ phone: '9812345678', countryCode: '+91' }`.
 * Normalize to the internal '919812345678' shape used by Redis keys,
 * repository queries, and audit rows.
 */
export function normalizeMobile(phone: string, countryCode: string): string {
  return `${countryCode.replace('+', '')}${phone}`;
}

/**
 * Mask a mobile number for logs — first 4 + last 2 remain, middle redacted.
 * Never log a bare mobile; always route through this.
 *   '919812345678'  →  '9198****78'
 *   '917'           →  '****'         (too short to safely mask)
 */
export function maskMobile(mobile: string): string {
  return mobile.length < 8 ? '****' : `${mobile.slice(0, 4)}****${mobile.slice(-2)}`;
}

/**
 * First OTP_PREFIX_LENGTH characters of the mobile — used as an anti-pumping
 * bucket key. Groups numbers by country code + operator prefix so an SMS-
 * pumping farm cycling through one operator's number pool hits one bucket.
 *
 * Kept in shared/utils (not shared/otp) because "first-N chars of a mobile"
 * is a generic bucketing primitive; the fact that OTP is the only current
 * consumer is a scope note, not a design one.
 */
export function bucketPrefix(mobile: string): string {
  return mobile.slice(0, OTP_PREFIX_LENGTH);
}
