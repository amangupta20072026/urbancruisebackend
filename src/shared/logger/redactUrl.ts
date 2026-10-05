/**
 * ==============================================================================
 * redactUrl — strip secrets embedded in URL paths before they are logged
 * ==============================================================================
 * Some provider callbacks authenticate with a shared secret IN THE PATH
 * because the provider cannot sign requests (MSG91 DLR:
 * /webhooks/msg91/<SECRET>/delivery). Pino's `redact` option only works on
 * object keys, not on substrings of a string field, so `req.url` would
 * otherwise write the secret into every access-log line (audit fix #3).
 *
 * EVERY place that logs or echoes a URL must pass it through this function:
 *   - shared/logger/httpLogger.ts  (access log `url` field)
 *   - shared/http/middleware/notFound.ts  (404 message → error log + response)
 *
 * Matching is case-insensitive and tolerates repeated slashes because Express
 * routing is case-insensitive by default — `/WEBHOOKS/MSG91/<secret>/delivery`
 * still reaches the webhook handler, so it must still be redacted.
 *
 * Adding another secret-in-path route? Add its pattern to SECRET_PATH_PATTERNS
 * and a case to the test file.
 * ==============================================================================
 */

const REDACTED = '[REDACTED]';

/** Group 1 = the prefix to keep; the segment after it is the secret. */
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
