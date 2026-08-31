/**
 * ==============================================================================
 * Crypto helpers
 * ==============================================================================
 * Wrap Node's crypto with the timing-safe primitives you actually want. Direct
 * `===` on secrets leaks by CPU-time side-channel; `timingSafeEqual` doesn't.
 * ==============================================================================
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Timing-safe string comparison — use for HMACs, tokens, OTPs. */
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
