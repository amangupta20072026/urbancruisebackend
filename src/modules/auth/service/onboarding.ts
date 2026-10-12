/**
 * POST /auth/customer/onboard: the only place the app creates a customer.
 * The single-use ticket from verifyOtp is the proof of phone ownership.
 */
import { sha256 } from '../../../shared/utils/crypto.js';
import { AuthError, ForbiddenError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';
import { maskMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { AuthenticatedResponseDto, CustomerOnboardingDetails, DeviceMeta } from '../types.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { mintAuthenticatedSession } from './mint-session.js';
import { assertRoleEnabled } from '../../../shared/rbac/enabled-roles.js';

export type CompleteOnboardingParams = {
  onboardingToken: string;
  details: CustomerOnboardingDetails;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
};

export async function completeCustomerOnboarding(
  deps: AuthServiceDeps,
  p: CompleteOnboardingParams,
): Promise<AuthenticatedResponseDto> {
  // Before consuming the ticket, so it stays usable if the role is re-enabled.
  assertRoleEnabled(deps.enabledRoles, 'customer');

  const { store, repo } = deps;

  // Atomic read + delete. Missing, expired or used → ONBOARDING_EXPIRED.
  const ticket = await store.takeOnboardingTicket(sha256(p.onboardingToken));
  if (!ticket) {
    throw new AuthError(
      'Your verification has expired. Please enter your mobile number again.',
      AUTH_ERROR.ONBOARDING_EXPIRED,
    );
  }

  // Must be the device that verified the OTP.
  if (ticket.deviceId !== p.device.id) {
    logger.warn(
      { alarm: 'onboarding_device_mismatch', mobile: maskMobile(ticket.mobile) },
      'onboarding ticket presented from a different device — rejected',
    );
    throw new AuthError(
      'Please verify your mobile number again on this device.',
      AUTH_ERROR.ONBOARDING_INVALID,
    );
  }

  // The number may have been blocked since the OTP was verified.
  const flags = await repo.getMobileFlags(ticket.mobile);
  if (flags?.admin_blocked === 1) {
    throw new ForbiddenError('This number cannot use the service.', AUTH_ERROR.MOBILE_BLOCKED);
  }

  // Duplicate-safe: returns an existing row instead of inserting.
  const { user, created } = await repo.createCustomerIfAbsent(ticket.mobile, p.details);
  logger.info(
    { mobile: maskMobile(ticket.mobile), customerId: user.entityId, created },
    created ? 'customer onboarded' : 'onboarding hit an existing customer — logged in instead',
  );

  return mintAuthenticatedSession(deps, user, {
    mobile: ticket.mobile,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
  });
}
