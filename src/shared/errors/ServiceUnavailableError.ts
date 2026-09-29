import { AppError } from './AppError.js';

/**
 * 503 — an upstream/dependency the API relies on is temporarily unavailable.
 *
 * Use when the request itself is fine but we cannot fulfil it right now:
 *   - The OTP provider (MSG91) has no wallet balance.
 *   - The circuit breaker for a downstream provider is open.
 *   - A database replica the endpoint requires is unreachable during a failover.
 *
 * DO NOT use for authentication or authorization problems (401/403), for
 * validation problems (400), or for programmer errors (500). 503 signals
 * "try again shortly" — clients are expected to retry with backoff. Every
 * throw should be paired with a stable `code` so the mobile client can
 * distinguish causes even though it treats them all as "try later" for the
 * user.
 */
export class ServiceUnavailableError extends AppError {
  constructor(
    message = 'This service is temporarily unavailable. Please try again shortly.',
    code = 'SERVICE_UNAVAILABLE',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 503, details });
  }
}
