import { AppError } from './AppError.js';

/** 400 — request body / params / query failed a Zod schema. `details` holds the Zod issues array. */
export class ValidationError extends AppError {
  constructor(
    message = 'The request payload is invalid.',
    details?: unknown,
    code = 'VALIDATION_FAILED',
  ) {
    super({ code, message, statusCode: 400, details });
  }
}
