import { AppError } from './AppError.js';

/**
 * 429: rate limit hit. retryAfter (seconds) is sent as the Retry-After header
 * and also as details.retryAfter for the mobile app.
 */
export class RateLimitError extends AppError {
  public readonly retryAfter: number | undefined;

  constructor(
    message = 'Too many requests. Please try again later.',
    code = 'RATE_LIMITED',
    opts?: { retryAfter?: number; details?: Record<string, unknown> },
  ) {
    const mergedDetails: Record<string, unknown> | undefined =
      opts?.retryAfter !== undefined
        ? { ...(opts.details ?? {}), retryAfter: opts.retryAfter }
        : opts?.details;

    super({ code, message, statusCode: 429, details: mergedDetails });
    this.retryAfter = opts?.retryAfter;
  }
}
