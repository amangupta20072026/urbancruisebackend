/**
 * Signs and verifies access and refresh JWTs (HS256), each with its own
 * secret. Verification failures throw AuthError (401).
 */
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { ENV } from '../../config/env.js';
import { AuthError } from '../errors/index.js';
import type { UserRole } from '../rbac/roles.js';

// expiresIn without undefined, for exactOptionalPropertyTypes.
type Duration = NonNullable<SignOptions['expiresIn']>;

/**
 * Access token claims: user id, role, entity id and session id. The session id
 * is the auth_sessions jti. Logout adds it to the Redis deny-list so this access
 * token stops working immediately.
 */
export type AccessTokenClaims = JwtPayload & {
  sub: string; // user id
  role: UserRole;
  entityId: string;
  /** Session id (the auth_sessions jti). Logout adds it to the Redis
   *  deny-list so this access token stops working immediately. */
  sid: string;
};

/**
 * Refresh token claims: user id, session id and optional mobile number. The
 * session id is the auth_sessions jti. Logout revokes the session so this
 * refresh token stops working immediately. The mobile number is kept across
 * rotations so refresh can check the number still belongs to this user.
 */
export type RefreshTokenClaims = JwtPayload & {
  sub: string; // user id
  jti: string; // auth_sessions row id
  /**
   * Mobile that started the session (e.g. '919812345678'). Kept across
   * rotations so refresh can check the number still belongs to this user.
   * Optional: older tokens don't have it and skip that check.
   */
  mob?: string;
};

/**
 * Signs an access token with the given claims. The claims must not include iat,
 * exp, iss or aud; those are added automatically.
 */
export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
): string {
  return jwt.sign(claims, ENV.JWT_ACCESS_SECRET, {
    expiresIn: ENV.JWT_ACCESS_TTL as Duration,
  });
}

/**
 * Signs a refresh token with the given claims. The claims must not include iat,
 * exp, iss or aud; those are added automatically.
 */
export function signRefreshToken(
  claims: Omit<RefreshTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
): string {
  return jwt.sign(claims, ENV.JWT_REFRESH_SECRET, {
    expiresIn: ENV.JWT_REFRESH_TTL as Duration,
  });
}

/**
 * Verifies an access token and returns its claims. Throws AuthError (401) if the
 * token is invalid or expired.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, ENV.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessTokenClaims;
  } catch (err) {
    throw new AuthError('Access token is invalid or expired.', 'AUTH_INVALID_TOKEN', {
      cause: (err as Error).message,
    });
  }
}

/**
 * Verifies a refresh token and returns its claims. Throws AuthError (401) if the
 * token is invalid or expired.
 */
export function verifyRefreshToken(token: string): RefreshTokenClaims {
  try {
    return jwt.verify(token, ENV.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
    }) as RefreshTokenClaims;
  } catch (err) {
    throw new AuthError('Refresh token is invalid or expired.', 'AUTH_INVALID_REFRESH', {
      cause: (err as Error).message,
    });
  }
}
