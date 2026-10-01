/**
 * ==============================================================================
 * auth.service — MSG91 dispatch outcome handling
 * ==============================================================================
 * Every provider failure has two orthogonal concerns:
 *
 *   1. Observability — logDispatchFailure() picks a log level (fatal / error
 *      / warn) that matches operational urgency. `alarm=...` fields are the
 *      hooks your alerting stack matches on (Loki / Datadog / Grafana etc.).
 *
 *   2. Client contract — throwDispatchError() converts the outcome into an
 *      AppError subclass with a stable `code` the mobile app already handles.
 *      Never returns; the caller should not have code after the call.
 *
 * Kept apart because the two evolve independently. Adding a new alarm hook
 * or renaming a log tag should never risk changing what the client sees;
 * adding a new error code should never risk paging on-call by accident.
 * ==============================================================================
 */
import { logger } from '../../../shared/logger/index.js';
import {
  ConflictError,
  ServiceUnavailableError,
  type AppError,
} from '../../../shared/errors/index.js';
import type { OtpDispatchResult } from '../../../shared/providers/msg91/otp.js';
import { AUTH_ERROR } from '../types.js';
import { maskMobile } from '../../../shared/utils/phone.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/**
 * Log a failed dispatch at a severity that matches operational urgency.
 *
 *   fatal   — config broken; pages on-call immediately.
 *   error   — provider outage; investigate but not necessarily paging.
 *   warn    — routine transient blip; monitor but don't page.
 */
export function logDispatchFailure(
  mobile: string,
  role: UserRole,
  dispatch: OtpDispatchResult,
): void {
  const base = {
    mobile: maskMobile(mobile),
    role,
    failure: dispatch.failure,
    providerErrorCode: dispatch.errorCode,
    providerErrorMessage: dispatch.errorMessage,
    attempts: dispatch.attempts,
  };
  switch (dispatch.failure) {
    case 'wallet_low':
      logger.fatal(
        { alarm: 'msg91_wallet_low', ...base },
        'msg91 wallet is empty — every OTP send is now failing until balance is topped up',
      );
      break;
    case 'template_bad':
    case 'provider_forbidden':
      logger.fatal(
        { alarm: 'msg91_config_broken', ...base },
        'msg91 auth or DLT template rejected — check MSG91_AUTH_KEY / MSG91_SMS_TEMPLATE_ID / MSG91_SMS_SENDER_ID',
      );
      break;
    case 'rate_limited':
      logger.error(
        { alarm: 'msg91_rate_limited', ...base },
        'msg91 is rate-limiting our account — traffic burst or DLT trap on their side',
      );
      break;
    case 'circuit_open':
      // The circuit is open because we already logged fatal when it opened.
      // Individual short-circuits are just warn — they're the breaker doing
      // its job, not new information.
      logger.warn(base, 'msg91 circuit breaker is open — short-circuited send');
      break;
    case 'provider_server_error':
      logger.error(base, 'msg91 returned 5xx after retry — provider-side outage');
      break;
    case 'timeout':
    case 'network':
      logger.warn(base, 'msg91 send failed with transient network condition after retry');
      break;
    case 'unknown':
    default:
      logger.error(base, 'msg91 send failed with unclassified provider response');
      break;
  }
}

/**
 * Convert a failed dispatch into an `AppError` subclass and throw. Never returns.
 *
 * Mapping rules:
 *   - Provider is temporarily unavailable (wallet empty, breaker open) → 503
 *     with `SERVICE_UNAVAILABLE`. The mobile client shows "try again shortly."
 *   - Provider rejected the request for a reason the user can't fix (config
 *     bug, bad template, our account is throttled) → 409 with `OTP_SEND_FAILED`.
 */
export function throwDispatchError(dispatch: OtpDispatchResult): never {
  const msg = dispatch.errorMessage ?? 'OTP send failed.';
  const err = mapDispatchToError(dispatch, msg);
  throw err;
}

function mapDispatchToError(dispatch: OtpDispatchResult, msg: string): AppError {
  switch (dispatch.failure) {
    case 'wallet_low':
    case 'circuit_open':
      return new ServiceUnavailableError(
        'OTP service is temporarily unavailable. Please try again shortly.',
        AUTH_ERROR.SERVICE_UNAVAILABLE,
        { reason: dispatch.failure },
      );
    case 'rate_limited':
      return new ConflictError(msg, 'provider_rate_limited');
    case 'template_bad':
    case 'provider_forbidden':
    case 'provider_server_error':
    case 'timeout':
    case 'network':
    case 'unknown':
    default:
      return new ConflictError(msg, AUTH_ERROR.OTP_SEND_FAILED);
  }
}
