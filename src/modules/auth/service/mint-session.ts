/**
 * The only place a login session is created (verifyOtp and onboarding):
 * signs tokens, stores the session, indexes it, loads the profile and
 * records the login.
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
  // `mob` ties the session to the login phone; refresh re-checks it.
  const refresh = signRefreshToken({ sub: user.userId, jti, mob: ctx.mobile });
  const access = signAccessToken({
    sub: user.userId,
    role: user.role,
    entityId: user.entityId,
    sid: jti,
  });

  // Same expiry for the DB row and the Redis index.
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);
  await repo.createSession({
    jti,
    role: user.role,
    entityId: user.entityId,
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
    entityId: user.entityId,
    requiresProfileSetup: user.requiresProfileSetup,
    profile,
  };
}
