import { AppError } from './AppError.js';

/** 401: missing, invalid or expired token. */
export class AuthError extends AppError {
  constructor(
    message = 'Authentication required.',
    code = 'AUTH_UNAUTHENTICATED',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 401, details });
  }
}
