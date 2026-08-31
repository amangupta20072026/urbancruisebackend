import { AppError } from './AppError.js';

/** 401 — no token, invalid token, expired token, wrong signature. */
export class AuthError extends AppError {
  constructor(
    message = 'Authentication required.',
    code = 'AUTH_UNAUTHENTICATED',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 401, details });
  }
}
