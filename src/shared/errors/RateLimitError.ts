import { AppError } from './AppError.js';

/** 429 — rate limiter tripped. Retry-After is set by the rate-limit middleware. */
export class RateLimitError extends AppError {
  constructor(
    message = 'Too many requests. Please try again later.',
    code = 'RATE_LIMITED',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 429, details });
  }
}
