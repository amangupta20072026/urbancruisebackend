import { AppError } from './AppError.js';

/**
 * 429 — rate limiter tripped.
 *
 * `retryAfter` is a first-class field (seconds) so the error handler can
 * emit the standard `Retry-After` HTTP header without special-casing.
 * Callers that don't know a specific value pass `undefined` and get the
 * base 429 with no header, which is still correct.
 *
 * The value is also stashed inside `details.retryAfter` for JSON clients
 * that read the error envelope directly (the mobile app does).
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number | undefined;

  constructor(
    message = 'Too many requests. Please try again later.',
    code = 'RATE_LIMITED',
    opts?: { retryAfter?: number; details?: Record<string, unknown> },
  ) {
    // Merge retryAfter into details so it appears in the wire envelope too.
    // `details` may or may not be an object; when it's not, we drop it —
    // callers that pass non-object details for a rate-limit case were
    // already relying on very loose typing.
    const mergedDetails: Record<string, unknown> | undefined =
      opts?.retryAfter !== undefined
        ? { ...(opts.details ?? {}), retryAfter: opts.retryAfter }
        : opts?.details;

    super({ code, message, statusCode: 429, details: mergedDetails });
    this.retryAfter = opts?.retryAfter;
  }
}
