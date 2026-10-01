/**
 * ==============================================================================
 * auth.service — session lifecycle (refresh, logout, /me)
 * ==============================================================================
 * All three functions operate on auth_sessions rows plus the session store's
 * deny-list that gives us real-time revocation on top of JWTs' inherent
 * statelessness.
 *
 * DESIGN CHANGE (DIP fix):
 *   Accepts AuthServiceDeps instead of importing the concrete redis /
 *   repo singletons. All infrastructure access goes through:
 *     deps.store  — IOtpSessionStore  (was: import { redis })
 *     deps.repo   — IAuthRepository   (was: import * as repo)
 * ==============================================================================
 */
import { ENV } from '../../../config/env.js';
import { safeEqual } from '../../../shared/utils/crypto.js';
import { newId } from '../../../shared/utils/id.js';
import { logger } from '../../../shared/logger/index.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../../shared/auth/jwt.js';
import { hashForStorage } from '../../../shared/auth/tokens.js';
import { AuthError } from '../../../shared/errors/index.js';
import { ttlToSeconds, expiryFromTtl } from '../../../shared/utils/duration.js';
import { AUTH_ERROR } from '../types.js';
import type { ResolvedUser, RefreshResponseDto, MeResponseDto, DeviceMeta } from '../types.js';
import type { UserRole, SubRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';

/* ==============================================================================
 * REFRESH
 * ============================================================================== */

export async function refreshSession(
  deps: AuthServiceDeps,
  refreshTokenStr: string,
  device: DeviceMeta,
  ip: string | null,
  userAgent: string | null,
): Promise<RefreshResponseDto> {
  const { store, repo } = deps;
  const claims = verifyRefreshToken(refreshTokenStr); // throws AuthError on bad token

  const row = await repo.findSessionByJti(claims.jti);
  if (!row) {
    throw new AuthError('Session not found.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Reuse detection — revoked jti presented → nuclear: revoke all for entity.
  if (row.revoked_at !== null) {
    const revokedJtis = await repo.revokeAllForEntity(row.role, row.entity_id, 'reuse_detected');
    await store.denyMandySessions(revokedJtis, ttlToSeconds(ENV.JWT_ACCESS_TTL));
    logger.warn(
      { role: row.role, entityId: row.entity_id, jti: row.jti },
      'refresh token reuse detected — all sessions revoked',
    );
    throw new AuthError('Session has been revoked.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Verify hash matches
  if (!safeEqual(hashForStorage(refreshTokenStr), row.refresh_token_hash)) {
    throw new AuthError('Refresh token invalid.', AUTH_ERROR.REFRESH_INVALID);
  }

  // Rotate: new jti + tokens
  const newJti = newId();
  const newRefresh = signRefreshToken({ sub: claims.sub as string, jti: newJti });
  const newAccess = signAccessToken({
    sub: claims.sub as string,
    role: row.role,
    subRole: (row.sub_role ?? null) as ResolvedUser['subRole'],
    entityId: row.entity_id,
    sid: newJti,
  });
  const newHash = hashForStorage(newRefresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  await repo.rotateSession(claims.jti, {
    jti: newJti,
    role: row.role,
    entityId: row.entity_id,
    subRole: (row.sub_role ?? null) as ResolvedUser['subRole'],
    refreshTokenHash: newHash,
    previousJti: claims.jti,
    device,
    ip,
    userAgent,
    expiresAt,
  });

  await Promise.all([
    store.removeActiveSession(row.role, row.entity_id, claims.jti),
    store.addActiveSession(row.role, row.entity_id, newJti),
    store.denySession(claims.jti, ttlToSeconds(ENV.JWT_ACCESS_TTL)),
  ]);

  return { accessToken: newAccess, refreshToken: newRefresh };
}

/* ==============================================================================
 * LOGOUT
 * ============================================================================== */

export type LogoutParams = {
  identityRole: UserRole;
  identityEntityId: string;
  identitySessionId: string;
  scope: 'current' | 'all';
};

export async function logout(deps: AuthServiceDeps, p: LogoutParams): Promise<void> {
  const { store, repo } = deps;
  const accessTtl = ttlToSeconds(ENV.JWT_ACCESS_TTL);

  if (p.scope === 'all') {
    const revoked = await repo.revokeAllForEntity(
      p.identityRole,
      p.identityEntityId,
      'all_devices',
    );
    await Promise.all([
      store.denyMandySessions(revoked, accessTtl),
      store.clearActiveSessions(p.identityRole, p.identityEntityId),
    ]);
    return;
  }

  await repo.markSessionRevoked(p.identitySessionId, 'logout');
  await Promise.all([
    store.removeActiveSession(p.identityRole, p.identityEntityId, p.identitySessionId),
    store.denySession(p.identitySessionId, accessTtl),
  ]);
}

/* ==============================================================================
 * GET IDENTITY (/auth/me)
 * ============================================================================== */

export type GetMeParams = {
  identityUserId: string;
  identityRole: UserRole;
  identitySubRole: SubRole;
  identityEntityId: string;
  identitySessionId: string;
};

export async function getMe(deps: AuthServiceDeps, p: GetMeParams): Promise<MeResponseDto> {
  const { store, repo } = deps;
  const details = await repo.loadIdentityDetails(p.identityRole, p.identityEntityId);

  if (!details) {
    const accessTtl = ttlToSeconds(ENV.JWT_ACCESS_TTL);
    await Promise.all([
      repo.markSessionRevoked(p.identitySessionId, 'admin').catch(() => {
        // best-effort — the deny-list is what actually protects the API
      }),
      store.denySession(p.identitySessionId, accessTtl),
      store.removeActiveSession(p.identityRole, p.identityEntityId, p.identitySessionId),
    ]);
    throw new AuthError('Your account is no longer available.', AUTH_ERROR.SESSION_ORPHANED);
  }

  return {
    userId: p.identityUserId,
    role: p.identityRole,
    subRole: p.identitySubRole,
    entityId: p.identityEntityId,
    requiresProfileSetup: details.requiresProfileSetup,
    profile: details.profile,
  };
}
