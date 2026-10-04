/**
 * ==============================================================================
 * auth.service — verifyOtp
 * ==============================================================================
 * Orchestrates POST /auth/otp/verify.
 *
 * ORDER OF CHECKS (keep this order):
 *   1. Mobile blocked / locked?
 *   2. Load OTP session by requestId; it must belong to this mobile + role.
 *   3. Compare HMAC(otp) in constant time.
 *        wrong → windowed fail counter; crossing the threshold locks the
 *                number for VERIFY_LOCK_DURATION_SECONDS.
 *   4. Correct → delete the session immediately (single use).
 *   5. Resolve the account for the requested role:
 *        Vendor / UC / Driver  — must exist AND be active, else 403.
 *                                Never created here.
 *        Customer, exists      — log in.
 *        Customer, new         — NOTHING is written to `customers`. Issue a
 *                                single-use onboarding ticket and return
 *                                { status: 'onboarding_required' }. The row
 *                                is created by POST /auth/customer/onboard.
 *   6. Mint the session (shared helper) and return { status: 'authenticated' }.
 * ==============================================================================
 */
import { randomBytes } from 'node:crypto';
import {
  VERIFY_FAIL_WINDOW_SECONDS,
  VERIFY_FAIL_LOCK_THRESHOLD,
  VERIFY_LOCK_DURATION_SECONDS,
  ONBOARDING_TICKET_TTL_SECONDS,
} from '../../../config/constants.js';
import { sha256, safeEqual } from '../../../shared/utils/crypto.js';
import { AuthError, ForbiddenError, RateLimitError } from '../../../shared/errors/index.js';
import { normalizeMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { VerifyOtpResponseDto, DeviceMeta } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { audit } from './audit.js';
import { hashOtp } from './otp-hash.js';
import { mintAuthenticatedSession } from './mint-session.js';

export type VerifyOtpParams = {
  phone: string;
  countryCode: '+91';
  role: UserRole;
  otp: string;
  requestId?: string;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
};

export async function verifyOtp(
  deps: AuthServiceDeps,
  p: VerifyOtpParams,
): Promise<VerifyOtpResponseDto> {
  const { store, repo } = deps;
  const mobile = normalizeMobile(p.phone, p.countryCode);

  // 1. Mobile blocked / locked?
  const flags = await repo.getMobileFlags(mobile);
  if (flags?.admin_blocked === 1) {
    throw new ForbiddenError('This number cannot use the service.', AUTH_ERROR.MOBILE_BLOCKED);
  }
  if (flags?.verify_locked_until && flags.verify_locked_until > new Date()) {
    const retryAfter = Math.ceil((flags.verify_locked_until.getTime() - Date.now()) / 1000);
    throw new RateLimitError(
      'This number is locked after too many wrong attempts.',
      AUTH_ERROR.ACCOUNT_LOCKED,
      { retryAfter },
    );
  }

  // 2. Load session
  if (!p.requestId) {
    throw new AuthError('Missing OTP session — request a new code.', AUTH_ERROR.OTP_EXPIRED);
  }
  const session = await store.getOtpSession(p.requestId);
  if (!session) {
    throw new AuthError('This OTP has expired.', AUTH_ERROR.OTP_EXPIRED);
  }
  if (session.mobile !== mobile || session.role !== p.role) {
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 3. Compare
  if (!safeEqual(hashOtp(p.requestId, p.otp), session.otpHash)) {
    // The Redis counter is windowed (expires VERIFY_FAIL_WINDOW_SECONDS after
    // the first failure) and is the authority for locking. The DB counter is
    // kept for visibility in mobile_registry and is reset when a lock is set.
    const fails = await store.incrementVerifyFail(mobile, VERIFY_FAIL_WINDOW_SECONDS);
    await repo.incrementVerifyFailure(mobile);
    if (fails >= VERIFY_FAIL_LOCK_THRESHOLD) {
      const until = new Date(Date.now() + VERIFY_LOCK_DURATION_SECONDS * 1000);
      const captchaUntil = new Date(Date.now() + 60 * 60 * 1000);
      await repo.lockMobile(mobile, until, captchaUntil);
      await store.deleteVerifyFail(mobile);
      await store.deleteOtpSession(p.requestId); // a locked number needs a fresh OTP
    }
    await audit(deps.audit, { mobile, role: p.role, event: 'verify_failed', ip: p.ip });
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 4. Single-use
  await store.deleteOtpSession(p.requestId);
  await Promise.all([
    audit(deps.audit, { mobile, role: p.role, event: 'verify_succeeded', ip: p.ip }),
    repo.resetVerifyFailure(mobile),
    store.deleteVerifyFail(mobile),
  ]);

  // 5. Resolve account
  const user = await repo.findUserByPhone(p.role, mobile);

  if (!user) {
    if (p.role !== 'customer') {
      await repo.insertLoginEvent({
        role: p.role,
        entityId: null,
        mobile,
        outcome: 'account_not_provisioned',
        device: p.device,
        ip: p.ip,
        userAgent: p.userAgent,
      });
      throw new ForbiddenError(
        'This number is not registered for this role. Please contact your Urban Cruise administrator.',
        AUTH_ERROR.ACCOUNT_NOT_PROVISIONED,
        { role: p.role },
      );
    }

    // New customer → onboarding ticket, no DB write.
    const onboardingToken = randomBytes(32).toString('base64url');
    await store.setOnboardingTicket(
      sha256(onboardingToken),
      { mobile, deviceId: p.device.id, issuedAt: Date.now() },
      ONBOARDING_TICKET_TTL_SECONDS,
    );
    return {
      status: 'onboarding_required',
      onboardingToken,
      expiresInSeconds: ONBOARDING_TICKET_TTL_SECONDS,
      role: 'customer',
    };
  }

  if (user.status !== 'active') {
    await repo.insertLoginEvent({
      role: user.role,
      entityId: user.entityId,
      mobile,
      outcome: 'account_suspended',
      device: p.device,
      ip: p.ip,
      userAgent: p.userAgent,
    });
    throw new ForbiddenError(
      'This account is not active. Please contact your Urban Cruise administrator.',
      AUTH_ERROR.ACCOUNT_SUSPENDED,
    );
  }

  // 6. Mint
  return mintAuthenticatedSession(deps, user, {
    mobile,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
  });
}
