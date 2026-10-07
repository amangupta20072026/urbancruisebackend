/**
 * ==============================================================================
 * auth.service — verifyOtp
 * ==============================================================================
 * Orchestrates POST /auth/otp/verify.
 *
 * ORDER OF CHECKS (keep this order):
 *   0. Role enabled on this environment? (fix H2) — an OTP sent while the
 *      role was enabled cannot be redeemed after it is switched off.
 *   1. Mobile blocked / locked?
 *   2. Load OTP session by requestId; it must belong to this mobile + role.
 *   2b. ATOMICALLY count this attempt against the OTP (INCR) BEFORE
 *       comparing. Over OTP_MAX_VERIFY_ATTEMPTS → session burned, reject.
 *       (Audit fix #2: the old flow read the lock, compared, and only then
 *       counted — 200 parallel guesses were ALL evaluated.)
 *   3. Compare HMAC(otp) in constant time.
 *        wrong → windowed fail counter; crossing the threshold locks the
 *                number for VERIFY_LOCK_DURATION_SECONDS.
 *   4. Correct → atomically claim the session (DEL returns 1 for exactly one
 *      caller). A concurrent duplicate verify gets OTP_EXPIRED, so one OTP
 *      can never mint two login sessions.
 *   5. Resolve the account for the requested role:
 *        Vendor / UC / Driver  — must exist AND be active, else 403.
 *                                Never created here.
 *        Customer, exists      — log in.
 *        Customer, new         — NOTHING is written to `customers`. Issue a
 *                                single-use onboarding ticket and return
 *                                { status: 'onboarding_required' }. The row
 *                                is created by POST /auth/customer/onboard.
 *   6. Mint the session (shared helper) and return { status: 'authenticated' }.
 *
 * IP-BLOCK CONVERSION (finding M4):
 *   A successful claim credits one verify to the IP block the OTP was SENT
 *   from (stored on the session). That conversion signal is what lets busy
 *   carrier-CGNAT networks past the per-network soft cap while SMS-pumping
 *   ranges — whose OTPs are never typed in — stay blocked.
 *
 * LOCKOUT VISIBILITY (finding M3 — accepted trade-off, now monitored):
 *   The brute-force lock protects the NUMBER, so anyone who knows a number
 *   can lock it on purpose (request an OTP, type 5 wrong codes). That is
 *   accepted — removing the lock would allow code guessing — but it must be
 *   visible: the locking failure logs `alarm: 'otp_number_locked'` and its
 *   otp_events row carries msg 'number_locked'. Existing sessions are not
 *   affected by the lock; only new logins are refused while it lasts.
 * ==============================================================================
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
  // 0. Role gate (fix H2).
  assertRoleEnabled(deps.enabledRoles, p.role);

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

  // 2b. Count this attempt atomically BEFORE comparing. Parallel guesses get
  //     distinct values 1..N from the store, so at most OTP_MAX_VERIFY_ATTEMPTS
  //     of them are ever compared, regardless of concurrency.
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

  // 3. Compare
  if (!safeEqual(hashOtp(p.requestId, p.otp), session.otpHash)) {
    // The Redis counter is windowed (expires VERIFY_FAIL_WINDOW_SECONDS after
    // the first failure) and is the authority for locking. The DB counter is
    // kept for visibility in mobile_registry and is reset when a lock is set.
    const fails = await store.incrementVerifyFail(mobile, VERIFY_FAIL_WINDOW_SECONDS);
    await repo.incrementVerifyFailure(mobile);
    const locking = fails >= VERIFY_FAIL_LOCK_THRESHOLD;
    if (locking) {
      const until = new Date(Date.now() + VERIFY_LOCK_DURATION_SECONDS * 1000);
      const captchaUntil = new Date(Date.now() + 60 * 60 * 1000);
      await repo.lockMobile(mobile, until, captchaUntil);
      await store.deleteVerifyFail(mobile);
      await store.deleteOtpSession(p.requestId); // a locked number needs a fresh OTP
      // M3: make deliberate lockouts visible. Repeated alarms for one number
      // (or one IP locking many numbers) means someone is doing it on purpose.
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

  // 4. Single-use — atomic claim. Only the caller whose delete removed the
  //    session may continue; a concurrent duplicate gets OTP_EXPIRED.
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

/**
 * Best-effort: a Redis hiccup here must never fail a login that has already
 * been verified. Worst case the block's conversion reads slightly low.
 * Test mobiles are never charged to a block, so never credited either.
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
