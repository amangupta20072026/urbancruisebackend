/**
 * ==============================================================================
 * authenticate — verify JWT, attach Identity, enforce enabled-roles guard
 * ==============================================================================
 * Extracts `Authorization: Bearer <token>`, verifies via `verifyAccessToken`,
 * and populates `req.identity`. On failure throws AuthError (401).
 *
 * ROLE GUARD (OCP fix):
 *   Previously, the set of enabled roles was a hardcoded constant inside this
 *   file. Adding a new role required a code change + redeploy. This violates
 *   OCP — the middleware should be closed for modification when new roles ship.
 *
 *   The set is now read from ENV.ENABLED_ROLES, which is parsed from the
 *   ENABLED_ROLES environment variable (comma-separated, default 'customer').
 *   To enable vendor features on a given deployment, set in .env:
 *     ENABLED_ROLES=customer,vendor
 *   No code changes, no redeployment of the middleware logic needed.
 *
 * Public / unauthenticated routes (like /health, /auth/*) simply don't mount
 * this middleware. Any route behind it is guaranteed to have `req.identity`.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { HEADER_AUTHORIZATION } from '../../../config/constants.js';
import { ENV } from '../../../config/env.js';
import { AuthError, ForbiddenError } from '../../errors/index.js';
import { verifyAccessToken } from '../../auth/jwt.js';
import type { Identity } from '../../types/identity.js';
import type { UserRole } from '../../rbac/roles.js';
import { redis } from '../../redis/client.js';
import { jwtDeny } from '../../redis/keys.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Roles whose features are wired up server-side — read from ENV at startup.
 * Configured via the ENABLED_ROLES environment variable (comma-separated).
 * Default: 'customer'.
 *
 * Evaluated once at module load (same timing as the old hardcoded Set).
 * No request-time overhead, no runtime config re-reads.
 */
const ENABLED_ROLES = new Set<UserRole>(ENV.ENABLED_ROLES as UserRole[]);

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header(HEADER_AUTHORIZATION);
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');

  const claims = verifyAccessToken(token);

  // Deny-list check — a logged-out or force-revoked sid gets rejected even
  // if the JWT is still cryptographically valid.
  const denied = await redis.get(jwtDeny(claims.sid));
  if (denied) {
    throw new AuthError('Session has been revoked.', 'AUTH_SESSION_REVOKED');
  }

  if (!ENABLED_ROLES.has(claims.role)) {
    throw new ForbiddenError(
      `Role '${claims.role}' is not enabled on this environment yet.`,
      'ROLE_NOT_ENABLED',
      { role: claims.role },
    );
  }

  const identity: Identity = {
    userId: String(claims.sub),
    role: claims.role,
    subRole: claims.subRole,
    entityId: claims.entityId,
    sessionId: claims.sid,
  };
  req.identity = identity;
  next();
};
