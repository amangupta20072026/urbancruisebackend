/**
 * ==============================================================================
 * auth.service — mintAuthenticatedSession
 * ==============================================================================
 * The ONE place a login session is created. Used by:
 *   • verifyOtp            — existing user, OTP correct
 *   • completeOnboarding   — new customer, onboarding form submitted
 *
 * Steps: sign tokens → insert auth_sessions row → index active session →
 *        load profile → login_events row → response DTO.
 * ==============================================================================
 */
import { ENV } from '../../../config/env.js';
import { newId } from '../../../shared/utils/id.js';
import { signAccessToken, signRefreshToken } from '../../../shared/auth/jwt.js';
import { hashForStorage } from '../../../shared/auth/tokens.js';
import { expiryFromTtl } from '../../../shared/utils/duration.js';
import type { AuthenticatedResponseDto, DeviceMeta, ResolvedUser } from '../types.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';

export type MintContext = {
  mobile: string;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
};

export async function mintAuthenticatedSession(
  deps: AuthServiceDeps,
  user: ResolvedUser,
  ctx: MintContext,
): Promise<AuthenticatedResponseDto> {
  const { store, repo } = deps;

  const jti = newId();
  // `mob` binds the session chain to the phone that logged in — refresh
  // re-checks it (see session.ts → refreshSession, audit fix #11).
  const refresh = signRefreshToken({ sub: user.userId, jti, mob: ctx.mobile });
  const access = signAccessToken({
    sub: user.userId,
    role: user.role,
    subRole: user.subRole,
    entityId: user.entityId,
    sid: jti,
  });

  // One value for the DB row AND the Redis index, so they always agree.
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);
  await repo.createSession({
    jti,
    role: user.role,
    entityId: user.entityId,
    subRole: user.subRole,
    refreshTokenHash: hashForStorage(refresh),
    previousJti: null,
    device: ctx.device,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    expiresAt,
  });
  await store.addActiveSession(user.role, user.entityId, jti, expiresAt);

  const profile = await repo.loadProfile(user.role, user.entityId);

  await repo.insertLoginEvent({
    role: user.role,
    entityId: user.entityId,
    mobile: ctx.mobile,
    outcome: 'success',
    device: ctx.device,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return {
    status: 'authenticated',
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
