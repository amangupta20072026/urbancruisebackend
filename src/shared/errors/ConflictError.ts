import { AppError } from './AppError.js';

/** 409: request conflicts with current state (e.g. duplicate). */
export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state.',
    code = 'CONFLICT',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 409, details });
  }
}
