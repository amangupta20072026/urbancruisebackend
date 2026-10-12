/**
 * Mobile number helpers. Internal format: country code + number, no '+'
 * (e.g. '919812345678').
 */
import { OTP_PREFIX_LENGTH } from '../../config/constants.js';

/** ('9812345678', '+91') → '919812345678' */
export function normalizeMobile(phone: string, countryCode: string): string {
  return `${countryCode.replace('+', '')}${phone}`;
}

/**
 * For logs: '919812345678' → '9198****78'. Under 8 chars → '****'.
 * Never log an unmasked mobile.
 */
export function maskMobile(mobile: string): string {
  return mobile.length < 8 ? '****' : `${mobile.slice(0, 4)}****${mobile.slice(-2)}`;
}

/**
 * First OTP_PREFIX_LENGTH chars (country code + operator prefix), so SMS
 * pumping across one number range shares one limit.
 */
export function bucketPrefix(mobile: string): string {
  return mobile.slice(0, OTP_PREFIX_LENGTH);
}
