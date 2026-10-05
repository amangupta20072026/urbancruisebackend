/**
 * ==============================================================================
 * auth.service — session lifecycle (refresh, logout, /me)
 * ==============================================================================
 * All three functions operate on auth_sessions rows plus the session store's
 * deny-list that gives us real-time revocation on top of JWTs' inherent
 * statelessness.
 *
 * PUSH TOKENS (audit fix #7): whenever a device or a whole account is signed
 * out — logout, logout-all, forced revoke, refresh-token reuse — the matching
 * push tokens are deleted too, so a signed-out phone stops receiving that
 * account's notifications. Cleanup is best-effort and never blocks sign-out.
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
import { AuthError, ForbiddenError } from '../../../shared/errors/index.js';
import { ttlToSeconds, expiryFromTtl } from '../../../shared/utils/duration.js';
import { AUTH_ERROR } from '../types.js';
import type { AuthSessionRow, RefreshResponseDto, MeResponseDto, DeviceMeta } from '../types.js';
import type { UserRole, SubRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import type { RevokeReason } from '../ports/IAuthRepository.js';

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
    await Promise.all([
      store.denyManySessions(revokedJtis, ttlToSeconds(ENV.JWT_ACCESS_TTL)),
      clearPushTokens(deps, row.role, row.entity_id, null),
    ]);
    logger.warn(
      { role: row.role, entityId: row.entity_id, jti: row.jti },
      'refresh token reuse detected — all sessions revoked',
    );
    throw new AuthError('Session has been revoked.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Verify hash matches + token belongs to this session's user
  if (
    !safeEqual(hashForStorage(refreshTokenStr), row.refresh_token_hash) ||
    String(claims.sub) !== String(row.entity_id)
  ) {
    throw new AuthError('Refresh token invalid.', AUTH_ERROR.REFRESH_INVALID);
  }

  // Re-validate the account on every refresh. The web app shares this DB, so
  // a staff member marked 'left', a vendor deactivated, or a deleted row must
  // lose mobile access at the next refresh — not 30 days later.
  const status = await repo.getAccountStatus(row.role, row.entity_id);
  if (status !== 'active') {
    await revokeEverything(deps, row.role, row.entity_id, 'admin_force');
    logger.warn(
      { role: row.role, entityId: row.entity_id, status: status ?? 'missing' },
      'refresh rejected — account no longer active; all sessions revoked',
    );
    if (status === null) {
      throw new AuthError('Your account is no longer available.', AUTH_ERROR.SESSION_ORPHANED);
    }
    throw new ForbiddenError(
      'This account is not active. Please contact your Urban Cruise administrator.',
      AUTH_ERROR.ACCOUNT_SUSPENDED,
    );
  }

  // Re-bind to the phone that started this session (audit fix #11).
  // Before this, refresh never re-checked WHO the phone belongs to: a vendor
  // manager whose number was removed from the vendor row, or a staff member
  // whose number was reassigned, kept access for the full 30-day refresh TTL,
  // and a changed vendor sub-role was ignored until the next login.
  // Re-running the login lookup on every refresh fixes both. Tokens issued
  // before `mob` existed skip this and age out within JWT_REFRESH_TTL.
  let subRole = (row.sub_role ?? null) as SubRole;
  if (claims.mob) {
    const current = await repo.findUserByPhone(row.role, claims.mob);
    if (!current || current.entityId !== row.entity_id) {
      await endSingleSession(deps, row, claims.jti);
      logger.warn(
        { role: row.role, entityId: row.entity_id, jti: claims.jti },
        'refresh rejected — the phone that started this session is no longer linked to the account',
      );
      throw new AuthError(
        'This number is no longer linked to your account. Please sign in again.',
        AUTH_ERROR.SESSION_REVOKED,
      );
    }
    subRole = current.subRole;
  }

  // Rotate: new jti + tokens (carrying the phone binding forward)
  const newJti = newId();
  const newRefresh = signRefreshToken({
    sub: claims.sub as string,
    jti: newJti,
    ...(claims.mob ? { mob: claims.mob } : {}),
  });
  const newAccess = signAccessToken({
    sub: claims.sub as string,
    role: row.role,
    subRole,
    entityId: row.entity_id,
    sid: newJti,
  });
  const newHash = hashForStorage(newRefresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  const rotated = await repo.rotateSession(claims.jti, {
    jti: newJti,
    role: row.role,
    entityId: row.entity_id,
    subRole,
    refreshTokenHash: newHash,
    previousJti: claims.jti,
    device,
    ip,
    userAgent,
    expiresAt,
  });
  if (!rotated) {
    // A concurrent refresh with the same token won the race. Nothing was
    // created for this request; the client must use the winner's tokens.
    throw new AuthError('Refresh already in progress.', AUTH_ERROR.REFRESH_INVALID);
  }

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
      store.denyManySessions(revoked, accessTtl),
      store.clearActiveSessions(p.identityRole, p.identityEntityId),
      clearPushTokens(deps, p.identityRole, p.identityEntityId, null),
    ]);
    return;
  }

  // Read the session's device BEFORE revoking, so we know which device's
  // push token to drop.
  const current = await repo.findSessionByJti(p.identitySessionId);
  await repo.markSessionRevoked(p.identitySessionId, 'logout');
  await Promise.all([
    store.removeActiveSession(p.identityRole, p.identityEntityId, p.identitySessionId),
    store.denySession(p.identitySessionId, accessTtl),
    current?.device_id
      ? clearPushTokens(deps, p.identityRole, p.identityEntityId, current.device_id)
      : Promise.resolve(),
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
  const { repo } = deps;
  const [status, details] = await Promise.all([
    repo.getAccountStatus(p.identityRole, p.identityEntityId),
    repo.loadIdentityDetails(p.identityRole, p.identityEntityId),
  ]);

  if (status === null || !details) {
    await revokeEverything(
      deps,
      p.identityRole,
      p.identityEntityId,
      'admin_force',
      p.identitySessionId,
    );
    throw new AuthError('Your account is no longer available.', AUTH_ERROR.SESSION_ORPHANED);
  }
  if (status !== 'active') {
    await revokeEverything(
      deps,
      p.identityRole,
      p.identityEntityId,
      'admin_force',
      p.identitySessionId,
    );
    throw new ForbiddenError(
      'This account is not active. Please contact your Urban Cruise administrator.',
      AUTH_ERROR.ACCOUNT_SUSPENDED,
    );
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

/* ==============================================================================
 * revokeEverything — DB revoke + deny-list every live access token + clear
 * the active-session index for one account.
 * ============================================================================== */
async function revokeEverything(
  deps: AuthServiceDeps,
  role: UserRole,
  entityId: string,
  reason: RevokeReason,
  currentSid?: string,
): Promise<void> {
  const { store, repo } = deps;
  const revoked = await repo.revokeAllForEntity(role, entityId, reason);
  // Always deny the caller's own sid, even if its DB row is already gone.
  if (currentSid && !revoked.includes(currentSid)) revoked.push(currentSid);
  await Promise.all([
    store.denyManySessions(revoked, ttlToSeconds(ENV.JWT_ACCESS_TTL)),
    store.clearActiveSessions(role, entityId),
    clearPushTokens(deps, role, entityId, null),
  ]);
}

/* ==============================================================================
 * endSingleSession — revoke ONE session chain (not the whole account).
 * ==============================================================================
 * Used when the phone that started a session no longer belongs to the
 * account. The account itself is fine — e.g. a vendor's owner and other
 * managers log in with their own phones — so only this chain ends.
 * ============================================================================== */
async function endSingleSession(
  deps: AuthServiceDeps,
  row: AuthSessionRow,
  jti: string,
): Promise<void> {
  const { store, repo } = deps;
  await repo.markSessionRevoked(jti, 'admin_force');
  await Promise.all([
    store.removeActiveSession(row.role, row.entity_id, jti),
    store.denySession(jti, ttlToSeconds(ENV.JWT_ACCESS_TTL)),
    row.device_id
      ? clearPushTokens(deps, row.role, row.entity_id, row.device_id)
      : Promise.resolve(),
  ]);
}

/* ==============================================================================
 * clearPushTokens — best-effort push-token removal on sign-out
 * ==============================================================================
 * Never throws: a failed cleanup must not turn a successful logout or a
 * security revoke into an error response. The token-claiming upsert in the
 * notifications module is the backstop if a delete is ever missed.
 * ============================================================================== */
async function clearPushTokens(
  deps: AuthServiceDeps,
  role: UserRole,
  entityId: string,
  deviceId: string | null,
): Promise<void> {
  try {
    await deps.repo.deletePushTokens(role, entityId, deviceId);
  } catch (err) {
    logger.warn(
      { err, role, entityId, scope: deviceId === null ? 'all_devices' : 'one_device' },
      'push token cleanup on sign-out failed',
    );
  }
}
