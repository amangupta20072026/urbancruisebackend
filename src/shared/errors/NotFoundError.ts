import { AppError } from './AppError.js';

/** 404: the requested resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', code = 'NOT_FOUND', details?: unknown) {
    super({ code, message, statusCode: 404, details });
  }
}
