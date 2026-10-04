/**
 * ==============================================================================
 * auth.service — completeCustomerOnboarding
 * ==============================================================================
 * Orchestrates POST /auth/customer/onboard — the ONLY place a customer row is
 * created from the mobile app.
 *
 *   1. Consume the onboarding ticket (atomic read+delete → single use).
 *      Missing / expired / already used → 401 ONBOARDING_EXPIRED.
 *   2. The ticket must come from the same device that verified the OTP.
 *   3. Re-check admin block on the number.
 *   4. createCustomerIfAbsent — per-mobile lock + re-check, so a double
 *      submit or a CRM row created in the meantime never makes a duplicate.
 *   5. Mint the session and return { status: 'authenticated' }.
 *
 * Proof of phone ownership is the ticket itself: it is only ever issued by
 * verifyOtp after a correct OTP for that exact mobile.
 * ==============================================================================
 */
import { sha256 } from '../../../shared/utils/crypto.js';
import { AuthError, ForbiddenError } from '../../../shared/errors/index.js';
import { logger } from '../../../shared/logger/index.js';
import { maskMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { AuthenticatedResponseDto, CustomerOnboardingDetails, DeviceMeta } from '../types.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { mintAuthenticatedSession } from './mint-session.js';

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
  const { store, repo } = deps;

  // 1. Single-use ticket
  const ticket = await store.takeOnboardingTicket(sha256(p.onboardingToken));
  if (!ticket) {
    throw new AuthError(
      'Your verification has expired. Please enter your mobile number again.',
      AUTH_ERROR.ONBOARDING_EXPIRED,
    );
  }

  // 2. Same device
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

  // 3. Admin block may have been applied after the OTP was verified
  const flags = await repo.getMobileFlags(ticket.mobile);
  if (flags?.admin_blocked === 1) {
    throw new ForbiddenError('This number cannot use the service.', AUTH_ERROR.MOBILE_BLOCKED);
  }

  // 4. Create (duplicate-safe)
  const { user, created } = await repo.createCustomerIfAbsent(ticket.mobile, p.details);
  logger.info(
    { mobile: maskMobile(ticket.mobile), customerId: user.entityId, created },
    created ? 'customer onboarded' : 'onboarding hit an existing customer — logged in instead',
  );

  // 5. Session
  return mintAuthenticatedSession(deps, user, {
    mobile: ticket.mobile,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
  });
}
