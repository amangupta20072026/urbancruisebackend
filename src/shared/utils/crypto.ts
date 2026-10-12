// Hashing and constant-time comparison helpers.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison. Use for secrets, tokens, hashes and OTPs. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** SHA-256 hex digest. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** HMAC-SHA-256 hex digest. Use for small inputs (e.g. OTPs) so a leaked
 *  hash can't be brute-forced without the key. */
export function hmacSha256(key: string, input: string): string {
  return createHmac('sha256', key).update(input).digest('hex');
}
