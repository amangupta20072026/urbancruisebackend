/**
 * ==============================================================================
 * JWT — access + refresh signing/verification
 * ==============================================================================
 * Two separate secrets so compromise of one doesn't compromise the other.
 * ==============================================================================
 */
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { ENV } from '../../config/env.js';
import { AuthError } from '../errors/index.js';
import type { UserRole, SubRole } from '../rbac/roles.js';

// jsonwebtoken's SignOptions.expiresIn is `number | StringValue | undefined`.
// Non-null-assert the branch we want at the call site so
// exactOptionalPropertyTypes doesn't complain about undefined leaking in.
type Duration = NonNullable<SignOptions['expiresIn']>;

export type AccessTokenClaims = JwtPayload & {
  sub: string; // userId
  role: UserRole;
  subRole: SubRole;
  entityId: string;
};

export type RefreshTokenClaims = JwtPayload & {
  sub: string; // userId
  jti: string; // token id — the DB row that tracks this refresh
};

export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
): string {
  return jwt.sign(claims, ENV.JWT_ACCESS_SECRET, {
    expiresIn: ENV.JWT_ACCESS_TTL as Duration,
  });
}

export function signRefreshToken(
  claims: Omit<RefreshTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'>,
): string {
  return jwt.sign(claims, ENV.JWT_REFRESH_SECRET, {
    expiresIn: ENV.JWT_REFRESH_TTL as Duration,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, ENV.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessTokenClaims;
  } catch (err) {
    throw new AuthError('Access token is invalid or expired.', 'AUTH_INVALID_TOKEN', {
      cause: (err as Error).message,
    });
  }
}

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
