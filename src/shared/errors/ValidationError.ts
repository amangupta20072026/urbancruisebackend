import { AppError } from './AppError.js';

/** 400: request failed schema validation; details holds the issues. */
export class ValidationError extends AppError {
  constructor(
    message = 'The request payload is invalid.',
    details?: unknown,
    code = 'VALIDATION_FAILED',
  ) {
    super({ code, message, statusCode: 400, details });
  }
}
