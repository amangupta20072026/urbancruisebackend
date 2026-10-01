/**
 * ==============================================================================
 * auth.service — session lifecycle (refresh, logout, /me)
 * ==============================================================================
 * All three functions operate on `auth_sessions` rows plus the Redis
 * deny-list (`jwt:deny:<sid>`) that gives us real-time revocation on top of
 * JWTs' inherent statelessness.
 *
 * Key behaviours:
 *   refreshSession — rotates the token pair. Presenting a refresh token that
 *                    was already revoked triggers the nuclear response
 *                    (revoke every session for this entity), because the
 *                    only reason a revoked jti reappears is that the token
 *                    was captured somewhere between us minting it and the
 *                    legitimate client rotating it.
 *   logout         — 'current' revokes this session only; 'all' revokes
 *                    every active session for the entity.
 *   getMe          — server-authoritative identity re-check on every mobile
 *                    cold-start. If the entity row has vanished (admin
 *                    deletion, GDPR erase), revoke the session AND deny-list
 *                    the sid so the token is dead everywhere in real time.
 * ==============================================================================
 */
import { redis } from '../../../shared/redis/client.js';
import { jwtDeny, sessionsActive } from '../../../shared/redis/keys.js';
import { ENV } from '../../../config/env.js';
import { safeEqual } from '../../../shared/utils/crypto.js';
import { newId } from '../../../shared/utils/id.js';
import { logger } from '../../../shared/logger/index.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../../shared/auth/jwt.js';
import { hashForStorage } from '../../../shared/auth/tokens.js';
import { AuthError } from '../../../shared/errors/index.js';
import { ttlToSeconds, expiryFromTtl } from '../../../shared/utils/duration.js';
import * as repo from '../repository/index.js';
import { AUTH_ERROR } from '../types.js';
import type { ResolvedUser, RefreshResponseDto, MeResponseDto, DeviceMeta } from '../types.js';
import type { UserRole, SubRole } from '../../../shared/rbac/roles.js';

/* ==============================================================================
 * REFRESH
 * ============================================================================== */

export async function refreshSession(
  refreshTokenStr: string,
  device: DeviceMeta,
  ip: string | null,
  userAgent: string | null,
): Promise<RefreshResponseDto> {
  const claims = verifyRefreshToken(refreshTokenStr); // throws AuthError on bad token

  const row = await repo.findSessionByJti(claims.jti);
  if (!row) {
    throw new AuthError('Session not found.', AUTH_ERROR.SESSION_REVOKED);
  }

  // Reuse detection — a revoked jti being presented means the entire chain
  // is compromised. Nuclear response: revoke every session for this entity.
  if (row.revoked_at !== null) {
    const revokedJtis = await repo.revokeAllForEntity(row.role, row.entity_id, 'reuse_detected');
    // Add each revoked sid to deny-list (best-effort — access tokens expire soon)
    await Promise.all(
      revokedJtis.map(sid => redis.set(jwtDeny(sid), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL))),
    );
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
    redis.srem(sessionsActive(row.role, row.entity_id), claims.jti),
    redis.sadd(sessionsActive(row.role, row.entity_id), newJti),
    // Deny the OLD access sid until it naturally expires
    redis.set(jwtDeny(claims.jti), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
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

export async function logout(p: LogoutParams): Promise<void> {
  if (p.scope === 'all') {
    const revoked = await repo.revokeAllForEntity(
      p.identityRole,
      p.identityEntityId,
      'all_devices',
    );
    await Promise.all([
      ...revoked.map(sid => redis.set(jwtDeny(sid), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL))),
      redis.del(sessionsActive(p.identityRole, p.identityEntityId)),
    ]);
    return;
  }

  await repo.markSessionRevoked(p.identitySessionId, 'logout');
  await Promise.all([
    redis.srem(sessionsActive(p.identityRole, p.identityEntityId), p.identitySessionId),
    redis.set(jwtDeny(p.identitySessionId), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
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

/**
 * Server-authoritative identity for the currently attached session.
 *
 * Fires on every mobile cold-start. Kept intentionally cheap — one indexed
 * lookup by primary key. No writes on the happy path.
 *
 * Orphan handling: if the entity row is gone (admin deletion, GDPR erase,
 * merged customer) we deny-list the sid so the token is dead on this and
 * every other instance, then throw AuthError so the client re-auths.
 */
export async function getMe(p: GetMeParams): Promise<MeResponseDto> {
  const details = await repo.loadIdentityDetails(p.identityRole, p.identityEntityId);

  if (!details) {
    // Session is valid but its owning row vanished. Revoke and reject.
    // Reason 'admin' is used because 'orphan' isn't in the auth_sessions
    // revoked_reason enum; audit intent is the same — a server-side forced
    // revoke, not a user action.
    await Promise.all([
      repo.markSessionRevoked(p.identitySessionId, 'admin').catch(() => {
        // best-effort — the deny-list is what actually protects the API
      }),
      redis.set(jwtDeny(p.identitySessionId), '1', 'EX', ttlToSeconds(ENV.JWT_ACCESS_TTL)),
      redis.srem(sessionsActive(p.identityRole, p.identityEntityId), p.identitySessionId),
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
