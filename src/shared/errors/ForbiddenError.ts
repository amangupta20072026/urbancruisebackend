import { AppError } from './AppError.js';

/** 403 — authenticated, but not allowed to do this action / see this resource. */
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code = 'AUTH_FORBIDDEN',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 403, details });
  }
}
