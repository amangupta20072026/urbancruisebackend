/**
 * ==============================================================================
 * auth.service — verifyOtp
 * ==============================================================================
 * Orchestrates POST /auth/otp/verify.
 *
 * ORDER OF CHECKS (matters — keep this order):
 *   1. Mobile locked?
 *   2. Load session store by requestId
 *   3. Verify OTP hash — safe-equal
 *   4. On success: single-use — DELETE session immediately
 *   5. Resolve user (create-if-customer / require-if-else)
 *   6. Check status
 *   7. Mint session + tokens (transactional)
 *   8. Load profile
 *   9. Insert login_events row
 *
 * DESIGN CHANGE (DIP fix):
 *   Accepts AuthServiceDeps. All Redis/DB access goes through
 *   deps.store and deps.repo respectively.
 * ==============================================================================
 */
import {
  VERIFY_FAIL_WINDOW_SECONDS,
  VERIFY_FAIL_LOCK_THRESHOLD,
  VERIFY_LOCK_DURATION_SECONDS,
} from '../../../config/constants.js';
import { ENV } from '../../../config/env.js';
import { sha256, safeEqual } from '../../../shared/utils/crypto.js';
import { newId } from '../../../shared/utils/id.js';
import { signAccessToken, signRefreshToken } from '../../../shared/auth/jwt.js';
import { hashForStorage } from '../../../shared/auth/tokens.js';
import { AuthError, ForbiddenError, RateLimitError } from '../../../shared/errors/index.js';
import { expiryFromTtl } from '../../../shared/utils/duration.js';
import { normalizeMobile } from '../../../shared/utils/phone.js';
import { AUTH_ERROR } from '../types.js';
import type { VerifyOtpResponseDto, DeviceMeta } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import { audit } from './audit.js';

/* ==============================================================================
 * Public entry
 * ============================================================================== */

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

  // 1. Mobile locked?
  const flags = await repo.getMobileFlags(mobile);
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
  const otpHash = sha256(p.otp);
  const match = safeEqual(otpHash, session.otpHash);

  if (!match) {
    const redisFailCount = await store.incrementVerifyFail(mobile, VERIFY_FAIL_WINDOW_SECONDS);
    void redisFailCount; // used only as a fast counter; DB is authoritative for locking
    const dbFails = await repo.incrementVerifyFailure(mobile);
    if (dbFails >= VERIFY_FAIL_LOCK_THRESHOLD) {
      const until = new Date(Date.now() + VERIFY_LOCK_DURATION_SECONDS * 1000);
      const captchaUntil = new Date(Date.now() + 60 * 60 * 1000);
      await repo.lockMobile(mobile, until, captchaUntil);
      await store.deleteVerifyFail(mobile);
    }
    await audit(deps.audit, { mobile, role: p.role, event: 'verify_failed', ip: p.ip });
    throw new AuthError('That code doesn\u2019t match.', AUTH_ERROR.OTP_INVALID);
  }

  // 4. Single-use — delete session before minting tokens
  await store.deleteOtpSession(p.requestId);

  // 5. Resolve user
  let user = await repo.findUserByPhone(p.role, mobile);
  if (!user) {
    if (p.role === 'customer') {
      user = await repo.createCustomerShell(mobile);
    } else {
      throw new ForbiddenError(
        `No ${p.role} account exists for this number.`,
        AUTH_ERROR.ACCOUNT_NOT_PROVISIONED,
      );
    }
  }

  // 6. Status check
  if (user.status === 'suspended' || user.status === 'deleted') {
    await audit(deps.audit, { mobile, role: p.role, event: 'verify_succeeded', ip: p.ip });
    await repo.insertLoginEvent({
      role: p.role,
      entityId: user.entityId,
      mobile,
      outcome: 'account_suspended',
      device: p.device,
      ip: p.ip,
      userAgent: p.userAgent,
    });
    throw new ForbiddenError('This account has been suspended.', AUTH_ERROR.ACCOUNT_SUSPENDED);
  }

  // 7. Mint tokens + create session row
  const jti = newId();
  const refresh = signRefreshToken({ sub: user.userId, jti });
  const access = signAccessToken({
    sub: user.userId,
    role: user.role,
    subRole: user.subRole,
    entityId: user.entityId,
    sid: jti,
  });
  const refreshHash = hashForStorage(refresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  await repo.createSession({
    jti,
    role: user.role,
    entityId: user.entityId,
    subRole: user.subRole,
    refreshTokenHash: refreshHash,
    previousJti: null,
    device: p.device,
    ip: p.ip,
    userAgent: p.userAgent,
    expiresAt,
  });
  await store.addActiveSession(user.role, user.entityId, jti);

  // 8. Load profile
  const profile = await repo.loadProfile(user.role, user.entityId);

  // 9. Audit + reset fail counters
  await Promise.all([
    audit(deps.audit, { mobile, role: p.role, event: 'verify_succeeded', ip: p.ip }),
    repo.resetVerifyFailure(mobile),
    store.deleteVerifyFail(mobile),
    repo.insertLoginEvent({
      role: user.role,
      entityId: user.entityId,
      mobile,
      outcome: 'success',
      device: p.device,
      ip: p.ip,
      userAgent: p.userAgent,
    }),
  ]);

  return {
    accessToken: access,
    refreshToken: refresh,
    userId: user.userId,
    role: user.role,
    subRole: user.subRole,
    entityId: user.entityId,
    requiresProfileSetup: user.requiresProfileSetup,
    profile,
  };
}
