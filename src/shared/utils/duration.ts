/**
 * The only parser for duration strings like '500ms', '30s', '15m', '1h',
 * '30d' (JWT TTLs). Keep durationRegex and ttlToSeconds() in sync.
 */
import { AppError } from '../errors/index.js';

/** Whole number + unit. Rejects '1.5h', '1', '15 m'. */
export const durationRegex = /^\d+(ms|s|m|h|d)$/;

/**
 * Duration string → seconds. 'ms' values round up (minimum 1) because Redis
 * TTLs are whole seconds and must be at least 1. Throws a 500 on bad input;
 * inputs are validated at startup, so that means a bug.
 */
export function ttlToSeconds(ttl: string): number {
  const m = durationRegex.exec(ttl);
  if (!m) {
    throw new AppError({
      code: 'BAD_TTL',
      message: `invalid TTL: ${ttl}`,
      statusCode: 500,
      isOperational: false,
    });
  }
  // Safe: the regex guarantees a unit and an all-digit number before it.
  const unit = m[1]!;
  const n = parseInt(ttl.slice(0, ttl.length - unit.length), 10);
  switch (unit) {
    case 'ms':
      return Math.max(1, Math.ceil(n / 1000));
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3_600;
    case 'd':
      return n * 86_400;
    default:
      // Unreachable: the regex only allows the units above.
      /* c8 ignore next 2 */
      return n;
  }
}

/** Date that is `ttl` from now. */
export function expiryFromTtl(ttl: string): Date {
  return new Date(Date.now() + ttlToSeconds(ttl) * 1_000);
}
