import { AppError } from './AppError.js';

/** 403: authenticated but not allowed. */
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code = 'AUTH_FORBIDDEN',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 403, details });
  }
}
