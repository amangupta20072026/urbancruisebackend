import { AppError } from './AppError.js';

/** 409 — unique-constraint hit, state conflict (e.g. cancel-already-cancelled), etc. */
export class ConflictError extends AppError {
  constructor(
    message = 'The request conflicts with the current state.',
    code = 'CONFLICT',
    details?: unknown,
  ) {
    super({ code, message, statusCode: 409, details });
  }
}
