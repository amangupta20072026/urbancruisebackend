/**
 * Hides secrets that appear in URL paths (the MSG91 webhook token) before a
 * URL is logged or returned. pino's redact can't mask part of a string, so
 * every logged URL must go through this. Matching ignores case and repeated
 * slashes, as Express routing does.
 */

const REDACTED = '[REDACTED]';

/** Group 1 is kept; the next path segment is replaced. */
const SECRET_PATH_PATTERNS: readonly RegExp[] = [/(\/+webhooks\/+msg91\/+)[^/?#]+/gi];

export function redactUrl(url: string): string;
export function redactUrl(url: string | undefined): string | undefined;
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  let out = url;
  for (const re of SECRET_PATH_PATTERNS) {
    out = out.replace(re, `$1${REDACTED}`);
  }
  return out;
}
