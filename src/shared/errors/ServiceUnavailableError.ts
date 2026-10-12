import { AppError } from './AppError.js';

/**
 * 503: the request is valid but a dependency is temporarily unavailable
 * (e.g. MSG91 wallet empty or circuit breaker open). Clients should retry.
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
