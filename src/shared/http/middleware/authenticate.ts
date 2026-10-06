/**
 * ==============================================================================
 * authenticate — verify JWT, attach Identity, enforce enabled-roles guard
 * ==============================================================================
 * Extracts `Authorization: Bearer <token>`, verifies via `verifyAccessToken`,
 * and populates `req.identity`. On failure throws AuthError (401).
 *
 * ROLE GUARD:
 *   Uses the SHARED guard from shared/rbac/enabled-roles.ts (fix H2) — the
 *   same set and the same 403 ROLE_NOT_ENABLED error as the OTP, onboarding
 *   and refresh doors. This file used to build its own private copy of the
 *   set; one source of truth means the doors can never disagree.
 *   To enable vendor features on a given deployment, set in .env:
 *     ENABLED_ROLES=customer,vendor
 *
 * Public / unauthenticated routes (like /health, /auth/*) simply don't mount
 * this middleware. Any route behind it is guaranteed to have `req.identity`.
 * ==============================================================================
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

  // Deny-list check — a logged-out or force-revoked sid gets rejected even
  // if the JWT is still cryptographically valid.
  const denied = await redis.get(jwtDeny(claims.sid));
  if (denied) {
    throw new AuthError('Session has been revoked.', 'AUTH_SESSION_REVOKED');
  }

  assertRoleEnabled(ENABLED_ROLE_SET, claims.role);

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
