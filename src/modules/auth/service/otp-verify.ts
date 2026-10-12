/**
 * POST /auth/otp/verify. The order of checks matters; see the step comments.
 * Vendor, driver and uc accounts are never created here. A new customer
 * gets a single-use onboarding ticket and nothing is written to customers.
 *
 * Five wrong codes lock the number for 15 minutes. Anyone who knows a
 * number can trigger this on purpose; that's accepted (it prevents
 * guessing) and alarmed as otp_number_locked. Existing sessions keep working.
 */
import { randomBytes } from 'node:crypto';
import {
  VERIFY_FAIL_WINDOW_SECONDS,
  VERIFY_FAIL_LOCK_THRESHOLD,
  VERIFY_LOCK_DURATION_SECONDS,
  ONBOARDING_TICKET_TTL_SECONDS,
  OTP_MAX_VERIFY_ATTEMPTS,
  OTP_SESSION_TTL_SECONDS,
} from '../../../config/constants.js';
import { sha256, safeEqual } from '../../../shared/utils/crypto.js';
import { AuthError, ForbiddenError, RateLimitError } from '../../../shared/errors/index.js';
import { normalizeMobile, maskMobile } from '../../../shared/utils/phone.js';
import { logger } from '../../../shared/logger/index.js';
import { AUTH_ERROR } from '../types.js';
import type { VerifyOtpResponseDto, DeviceMeta } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { audit } from './audit.js';
import { hashOtp } from './otp-hash.js';
import { mintAuthenticatedSession } from './mint-session.js';
import { assertRoleEnabled } from '../../../shared/rbac/enabled-roles.js';

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
  // 0. Role enabled? An OTP sent before the role was disabled can't be used.
  assertRoleEnabled(deps.enabledRoles, p.role);

  const { store, repo } = deps;
  const mobile = normalizeMobile(p.phone, p.countryCode);

  // 1. Admin block or brute-force lock.
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

  // 2. Session must exist and match this mobile and role.
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

  // 2b. Count the attempt atomically before comparing, so parallel guesses
  //     can't exceed OTP_MAX_VERIFY_ATTEMPTS.
  const attempt = await store.incrementOtpAttempts(p.requestId, OTP_SESSION_TTL_SECONDS);
  if (attempt > OTP_MAX_VERIFY_ATTEMPTS) {
    await store.deleteOtpSession(p.requestId);
    await audit(deps.audit, {
      mobile,
      role: p.role,
      event: 'verify_failed',
      ip: p.ip,
      msg: 'otp_attempts_exhausted',
    });
    throw new AuthError(
      'Too many incorrect attempts. Please request a new code.',
      AUTH_ERROR.OTP_EXPIRED,
    );
  }

  // 3. Constant-time compare.
  if (!safeEqual(hashOtp(p.requestId, p.otp), session.otpHash)) {
    // The windowed Redis counter decides the lock; the DB counter is for
    // visibility and resets when a lock is set.
    const fails = await store.incrementVerifyFail(mobile, VERIFY_FAIL_WINDOW_SECONDS);
    await repo.incrementVerifyFailure(mobile);
    const locking = fails >= VERIFY_FAIL_LOCK_THRESHOLD;
    if (locking) {
      const until = new Date(Date.now() + VERIFY_LOCK_DURATION_SECONDS * 1000);
      const captchaUntil = new Date(Date.now() + 60 * 60 * 1000);
      await repo.lockMobile(mobile, until, captchaUntil);
      await store.deleteVerifyFail(mobile);
      await store.deleteOtpSession(p.requestId); // needs a fresh OTP after the lock
      // Repeated alarms for one number, or one IP locking many, suggest abuse.
      logger.warn(
        {
          alarm: 'otp_number_locked',
          mobile: maskMobile(mobile),
          role: p.role,
          ip: p.ip,
          lockedUntil: until.toISOString(),
        },
        'otp verify: number locked after too many wrong codes',
      );
    }
    await audit(deps.audit, {
      mobile,
      role: p.role,
      event: 'verify_failed',
      ip: p.ip,
      ...(locking ? { msg: 'number_locked' } : {}),
    });
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 4. Atomic claim: one OTP can create only one session. A concurrent
  //    duplicate gets OTP_EXPIRED.
  const claimed = await store.deleteOtpSession(p.requestId);
  if (!claimed) {
    throw new AuthError('This OTP has already been used.', AUTH_ERROR.OTP_EXPIRED);
  }
  await Promise.all([
    audit(deps.audit, { mobile, role: p.role, event: 'verify_succeeded', ip: p.ip }),
    repo.resetVerifyFailure(mobile),
    store.deleteVerifyFail(mobile),
    creditIpBlockVerify(store, session.ipBlock, session.isTest),
  ]);

  // 5. Resolve the account.
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

    // New customer: onboarding ticket, no DB write.
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

  // 6. Start the session.
  return mintAuthenticatedSession(deps, user, {
    mobile,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
  });
}

/**
 * Credits the verify to the IP block the OTP was sent from. Best-effort:
 * must never fail a verified login. Test mobiles have no block.
 */
async function creditIpBlockVerify(
  store: AuthServiceDeps['store'],
  ipBlock: string | null | undefined,
  isTest: boolean,
): Promise<void> {
  if (!ipBlock || isTest) return;
  try {
    await store.recordIpBlockVerify(ipBlock);
  } catch (err) {
    logger.warn({ err, ipBlock }, 'otp verify: could not credit IP-block conversion');
  }
}
