/**
 * ==============================================================================
 * Duration helpers — the ONE place we parse TTL strings
 * ==============================================================================
 * The app uses strings like '15m' | '1h' | '30d' | '30s' | '500ms' in three
 * places:
 *   • env.ts        — validates JWT_ACCESS_TTL / JWT_REFRESH_TTL at boot
 *   • auth service  — computes access/refresh expiry Dates for the DB
 *   • auth service  — sets Redis EX seconds on deny-list entries
 *
 * Before, the regex was declared in env.ts and re-implemented in service.ts.
 * Two parsers meant two chances for divergence — e.g. env.ts accepts 'ms'
 * but if service.ts only accepted 's|m|h|d' a valid config would crash at
 * first use. Consolidated here.
 *
 * NOTE: keep `durationRegex` in sync with `ttlToSeconds`'s switch.
 * ==============================================================================
 */
import { AppError } from '../errors/index.js';

/** Accepts: 15m | 1h | 30s | 500ms | 30d. Rejects '1.5h', '1', '15 m'. */
export const durationRegex = /^\d+(ms|s|m|h|d)$/;

/**
 * '15m' | '1h' | '30d' | '30s' | '500ms' -> seconds.
 *
 * Sub-second inputs (e.g. '500ms') round UP to 1s because Redis EX and
 * mysql DATETIME don't do fractional seconds. Rounding down would produce
 * a 0-second TTL which Redis treats as "delete immediately".
 *
 * Throws `AppError` with statusCode 500 on malformed input — call sites
 * should always pass values already validated by `durationRegex` at boot,
 * so hitting this branch means an env-validation bug, not user input.
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
  // m[1] is the unit suffix (ms|s|m|h|d). The numeric part is everything
  // before it. Using parseInt on the full match minus the suffix is safe
  // because durationRegex already guarantees the prefix is all digits.
  // The non-null assertion is safe: the regex requires the capture group to
  // match, so m[1] is always a string when exec() returns non-null.
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
      // Unreachable — durationRegex only matches the units above.
      /* c8 ignore next 2 */
      return n;
  }
}

/** Convenience — Date in the future by `ttl` seconds. */
export function expiryFromTtl(ttl: string): Date {
  return new Date(Date.now() + ttlToSeconds(ttl) * 1_000);
}
