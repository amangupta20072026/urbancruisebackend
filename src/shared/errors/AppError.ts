/**
 * ==============================================================================
 * AppError — base of the error hierarchy
 * ==============================================================================
 * Every deliberately-thrown error in the codebase is a subclass of AppError.
 * The final `errorHandler` middleware translates AppError instances into HTTP responses.
 * Anything that is NOT an AppError is treated as a 500 bug and
 * logged with `err.stack`.
 *
 * Rules:
 *   - `statusCode` — the HTTP status to send.
 *   - `code`       — stable UPPER_SNAKE identifier. Never change; clients key
 *                    localized messages off this.
 *   - `isOperational` — true for expected-in-prod errors (bad input, no auth).
 *                       false for bugs. Used to decide whether to alert on-call.
 *   - `details` — optional structured extra data (Zod issues, conflicting field…).
 * ==============================================================================
 */

export type AppErrorOptions = {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
  cause?: unknown;
  isOperational?: boolean;
};

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(opts: AppErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.statusCode = opts.statusCode;
    this.details = opts.details;
    this.isOperational = opts.isOperational ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}
