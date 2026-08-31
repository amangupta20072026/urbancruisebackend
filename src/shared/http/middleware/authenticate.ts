/**
 * ==============================================================================
 * authenticate — verify JWT, attach Identity, enforce enabled-roles guard
 * ==============================================================================
 * Extracts `Authorization: Bearer <token>`, verifies via `verifyAccessToken`,
 * and populates `req.identity`. On failure throws AuthError (401).
 *
 * ROLE GUARD: only 'customer' is served today. A valid token with a
 * non-customer role is rejected with 403 `ROLE_NOT_ENABLED`. The type surface
 * of `UserRole` includes all four roles (JWT payloads carry them regardless);
 * this guard is where runtime scope narrows. When vendor / driver / uc
 * features ship, delete their role from ENABLED_ROLES.
 *
 * Public / unauthenticated routes (like /health, /auth/*) simply don't mount
 * this middleware. Any route behind it is guaranteed to have `req.identity`.
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { HEADER_AUTHORIZATION } from '../../../config/constants.js';
import { AuthError, ForbiddenError } from '../../errors/index.js';
import { verifyAccessToken } from '../../auth/jwt.js';
import type { Identity } from '../../types/identity.js';
import type { UserRole } from '../../rbac/roles.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Roles whose features are wired up server-side. Everything else gets 403 at
 * the auth boundary. Add roles here as their modules are implemented.
 */
const ENABLED_ROLES = new Set<UserRole>(['customer']);

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.header(HEADER_AUTHORIZATION);
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) throw new AuthError('Missing bearer token.', 'AUTH_MISSING_TOKEN');

  const claims = verifyAccessToken(token);

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
  };
  req.identity = identity;
  next();
};
