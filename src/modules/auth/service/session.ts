/**
 * Session lifecycle: refresh, logout and /me. Access tokens are revoked
 * instantly through the Redis deny-list. Every sign-out also deletes the
 * device's (or account's) push tokens, best-effort.
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
import { REFRESH_REUSE_GRACE_SECONDS } from '../../../config/constants.js';
import { assertRoleEnabled } from '../../../shared/rbac/enabled-roles.js';
import type {
  AuthSessionRow,
  RefreshResponseDto,
  MeResponseDto,
  DeviceMeta,
  SessionDevice,
} from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';
import type { AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import type { RevokeReason } from '../ports/IAuthRepository.js';

/* Refresh */

/** Placeholder written by older builds; treated as an unknown (null) device. */
export const LEGACY_PLACEHOLDER_DEVICE_ID = 'unknown-device';

/**
 * Device for the rotated session: the one sent with this refresh, else the
 * previous session's (legacy placeholder becomes null). Never invented,
 * because logout uses it to remove the right push token.
 */
export function resolveRefreshDevice(
  sent: DeviceMeta | null,
  previous: Pick<AuthSessionRow, 'device_id' | 'device_name' | 'platform' | 'app_version'>,
): SessionDevice {
  if (sent) return sent;
  if (previous.device_id === null || previous.device_id === LEGACY_PLACEHOLDER_DEVICE_ID) {
    return { id: null, name: null, platform: null, appVersion: null };
  }
  return {
    id: previous.device_id,
    name: previous.device_name,
    platform: previous.platform,
    appVersion: previous.app_version,
  };
}

export async function refreshSession(
  deps: AuthServiceDeps,
  refreshTokenStr: string,
  /** Device sent with this refresh, or null. */
  sentDevice: DeviceMeta | null,
  ip: string | null,
  userAgent: string | null,
): Promise<RefreshResponseDto> {
  const { store, repo } = deps;
  const claims = verifyRefreshToken(refreshTokenStr); // throws AuthError

  const row = await repo.findSessionByJti(claims.jti);
  if (!row) {
    throw new AuthError('Session not found.', AUTH_ERROR.SESSION_REVOKED);
  }

  // 'grace': duplicate of a refresh that just happened; gets a sibling session.
  let mode: 'rotate' | 'grace' = 'rotate';

  // A revoked token means possible theft: revoke every session for the
  // account, unless it's the app's own duplicate within the grace window.
  if (
    row.revoked_at !== null &&
    (await repo.isWithinRotationGrace(claims.jti, REFRESH_REUSE_GRACE_SECONDS))
  ) {
    mode = 'grace';
  } else if (row.revoked_at !== null) {
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

  // Token must match the stored hash and belong to this session's user.
  if (
    !safeEqual(hashForStorage(refreshTokenStr), row.refresh_token_hash) ||
    String(claims.sub) !== String(row.entity_id)
  ) {
    throw new AuthError('Refresh token invalid.', AUTH_ERROR.REFRESH_INVALID);
  }

  // Role must still be enabled. The session isn't revoked, so re-enabling resumes it.
  assertRoleEnabled(deps.enabledRoles, row.role);

  // Re-check the account every refresh: changes made in the web app (status,
  // deletion) take effect now, not when the refresh token expires.
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

  // The login phone must still belong to this account (e.g. not reassigned).
  // Older tokens without `mob` skip this and expire naturally.
  if (claims.mob) {
    const current = await repo.findUserByPhone(row.role, claims.mob);
    if (!current || current.entityId !== row.entity_id) {
      await endFamily(deps, row.role, row.entity_id, claims.jti, 'admin_force');
      logger.warn(
        { role: row.role, entityId: row.entity_id, jti: claims.jti },
        'refresh rejected — the phone that started this session is no longer linked to the account',
      );
      throw new AuthError(
        'This number is no longer linked to your account. Please sign in again.',
        AUTH_ERROR.SESSION_REVOKED,
      );
    }
  }

  // Rotate, carrying the phone binding forward.
  const newJti = newId();
  const newRefresh = signRefreshToken({
    sub: claims.sub as string,
    jti: newJti,
    ...(claims.mob ? { mob: claims.mob } : {}),
  });
  const newAccess = signAccessToken({
    sub: claims.sub as string,
    role: row.role,
    entityId: row.entity_id,
    sid: newJti,
  });
  const newHash = hashForStorage(newRefresh);
  const expiresAt = expiryFromTtl(ENV.JWT_REFRESH_TTL);

  const next = {
    jti: newJti,
    role: row.role,
    entityId: row.entity_id,
    refreshTokenHash: newHash,
    previousJti: claims.jti,
    // Inherit the login family. Rows from before the migration have no
    // family_id; their own jti then starts one, which still groups every
    // sibling created from this same token.
    familyId: row.family_id ?? row.jti,
    device: resolveRefreshDevice(sentDevice, row),
    ip,
    userAgent,
    expiresAt,
  };

  if (mode === 'rotate') {
    const rotated = await repo.rotateSession(claims.jti, next);
    if (!rotated) {
      // Lost the race to a concurrent refresh. Within the grace window, give
      // this request a sibling session rather than a 401 that logs the app out.
      if (!(await repo.isWithinRotationGrace(claims.jti, REFRESH_REUSE_GRACE_SECONDS))) {
        throw new AuthError('Refresh already in progress.', AUTH_ERROR.REFRESH_INVALID);
      }
      mode = 'grace';
    }
  }
  if (mode === 'grace') {
    // Atomic with logout: if the family was revoked meanwhile, refuse.
    if (!(await repo.createGraceSibling(next))) {
      throw new AuthError('Session has been revoked.', AUTH_ERROR.SESSION_REVOKED);
    }
    logger.info(
      { role: row.role, entityId: row.entity_id, oldJti: claims.jti, newJti },
      'refresh: duplicate within grace window — sibling session issued (not treated as reuse)',
    );
  }

  await Promise.all([
    store.removeActiveSession(row.role, row.entity_id, claims.jti),
    store.addActiveSession(row.role, row.entity_id, newJti, expiresAt),
    store.denySession(claims.jti, ttlToSeconds(ENV.JWT_ACCESS_TTL)),
  ]);

  return { accessToken: newAccess, refreshToken: newRefresh };
}

/* Logout */

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

  // Revoke the whole login family, not just this jti: a duplicate refresh
  // inside the grace window creates a sibling session that would otherwise
  // survive this logout.
  await endFamily(deps, p.identityRole, p.identityEntityId, p.identitySessionId, 'logout');
}

/* GET /auth/me */

export type GetMeParams = {
  identityUserId: string;
  identityRole: UserRole;
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
    entityId: p.identityEntityId,
    requiresProfileSetup: details.requiresProfileSetup,
    profile: details.profile,
  };
}

/** Revokes every session of an account: DB rows, deny-list and the active index. */
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

/**
 * Ends one login family (this device's session chain, including any grace
 * siblings), not the whole account. Used for "log out this device" and when
 * the session's login phone no longer belongs to the account.
 */
async function endFamily(
  deps: AuthServiceDeps,
  role: UserRole,
  entityId: string,
  sid: string,
  reason: RevokeReason,
): Promise<void> {
  const { store, repo } = deps;
  const current = await repo.findSessionByJti(sid);
  // Pre-migration rows have no family_id; fall back to the session itself.
  const familyId = current?.family_id ?? sid;
  const revoked = await repo.revokeFamily(role, entityId, familyId, reason);

  // Always end the caller's own sid, even if it was not in the family result
  // (already revoked, or a pre-migration row whose family_id is NULL).
  const jtis = new Set(revoked.map(r => r.jti));
  if (!jtis.has(sid)) {
    await repo.markSessionRevoked(sid, reason);
    jtis.add(sid);
  }

  const deviceIds = new Set<string>();
  for (const r of revoked) if (r.deviceId) deviceIds.add(r.deviceId);
  if (current?.device_id) deviceIds.add(current.device_id);

  const accessTtl = ttlToSeconds(ENV.JWT_ACCESS_TTL);
  await Promise.all([
    store.denyManySessions([...jtis], accessTtl),
    ...[...jtis].map(j => store.removeActiveSession(role, entityId, j)),
    ...[...deviceIds].map(d => clearPushTokens(deps, role, entityId, d)),
  ]);
}

/**
 * Removes push tokens on sign-out. Never throws, so it can't fail a logout or
 * revoke; token claiming in notifications is the backstop.
 */
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
