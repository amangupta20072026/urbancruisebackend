/**
 * Base class for all intentionally thrown errors. errorHandler turns these
 * into HTTP responses; any other error becomes a 500.
 *
 * code: stable identifier the app relies on — never rename an existing one.
 * isOperational: false marks a bug and is logged at error level.
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
