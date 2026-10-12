/**
 * MSG91 send failures: logDispatchFailure() logs at a severity matching the
 * urgency (with `alarm` fields for alerting); throwDispatchError() maps the
 * failure to the stable error the app expects. Kept separate so logging
 * changes never alter the API contract.
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

/** fatal: config broken (page). error: provider outage. warn: transient blip. */
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
      // Opening the breaker was already logged; each short-circuit is just a warn.
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
 * Throws the client-facing error for a failed send. Statuses and codes are
 * an API contract; don't change them:
 *   unavailable (wallet empty, breaker open) → 503 SERVICE_UNAVAILABLE
 *   provider throttling                      → 409 provider_rate_limited
 *   anything else                            → 409 OTP_SEND_FAILED
 * Messages are fixed and generic: MSG91's raw error reveals our account
 * setup, so it only goes to logs and otp_events.
 */
export const DISPATCH_CLIENT_MESSAGE = {
  unavailable: 'OTP service is temporarily unavailable. Please try again shortly.',
  busy: 'Our SMS service is busy right now. Please try again in a minute.',
  failed: 'We could not send the verification code. Please try again.',
} as const;

export function throwDispatchError(dispatch: OtpDispatchResult): never {
  throw mapDispatchToError(dispatch);
}

function mapDispatchToError(dispatch: OtpDispatchResult): AppError {
  switch (dispatch.failure) {
    case 'wallet_low':
    case 'circuit_open':
      return new ServiceUnavailableError(
        DISPATCH_CLIENT_MESSAGE.unavailable,
        AUTH_ERROR.SERVICE_UNAVAILABLE,
      );
    case 'rate_limited':
      return new ConflictError(DISPATCH_CLIENT_MESSAGE.busy, 'provider_rate_limited');
    case 'template_bad':
    case 'provider_forbidden':
    case 'provider_server_error':
    case 'timeout':
    case 'network':
    case 'unknown':
    default:
      return new ConflictError(DISPATCH_CLIENT_MESSAGE.failed, AUTH_ERROR.OTP_SEND_FAILED);
  }
}
