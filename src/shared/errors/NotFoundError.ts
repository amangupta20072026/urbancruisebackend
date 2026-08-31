import { AppError } from './AppError.js';

/** 404 — subject not found. Prefer this over silent empty responses when the caller identified a specific ID. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', code = 'NOT_FOUND', details?: unknown) {
    super({ code, message, statusCode: 404, details });
  }
}
