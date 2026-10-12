/**
 * Verifies the Bearer access token and sets req.identity. Rejects revoked
 * sessions (401) and roles not enabled on this environment (403).
 * Public routes simply don't use this middleware.
 */
import type { RequestHandler } from 'express';
import { HEADER_AUTHORIZATION } from '../../../config/constants.js';
import { AuthError } from '../../errors/index.js';
import { verifyAccessToken } from '../../auth/jwt.js';
import type { Identity } from '../../types/identity.js';
import { ENABLED_ROLE_SET, assertRoleEnabled } from '../../rbac/enabled-roles.js';
import { redis } from '../../redis/client.js';
import { jwtDeny } from '../../redis/keys.js';

const BEARER_PREFIX = 'Bearer ';

export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header(HEADER_AUTHORIZATION);
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');

  const claims = verifyAccessToken(token);

  // Reject logged-out or revoked sessions even if the JWT is still valid.
  const denied = await redis.get(jwtDeny(claims.sid));
  if (denied) {
    throw new AuthError('Session has been revoked.', 'AUTH_SESSION_REVOKED');
  }

  assertRoleEnabled(ENABLED_ROLE_SET, claims.role);

  const identity: Identity = {
    userId: String(claims.sub),
    role: claims.role,
    entityId: claims.entityId,
    sessionId: claims.sid,
  };
  req.identity = identity;
  next();
};
