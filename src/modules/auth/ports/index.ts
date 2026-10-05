/**
 * ==============================================================================
 * auth ports — barrel
 * ==============================================================================
 * Re-exports every port (interface) and shared input type defined in this
 * directory. Service files and infrastructure files import from here.
 * ==============================================================================
 */

export type { IOtpSessionStore, IdempotencySnapshot } from './IOtpSessionStore.js';
export type {
  IAuthRepository,
  OtpEventInsert,
  LoginEventInsert,
  DlrUpdate,
} from './IAuthRepository.js';
export type { IAuditSink, AuditEventInput } from './IAuditSink.js';
export type { ICaptchaVerifier, CaptchaVerdict } from './ICaptchaVerifier.js';
