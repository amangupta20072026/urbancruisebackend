/**
 * ==============================================================================
 * Refresh-token store — hashed, rotated, revocable
 * ==============================================================================
 * SCHEMA (create in your DB before shipping):
 *
 *   CREATE TABLE refresh_tokens (
 *     id           CHAR(36) PRIMARY KEY,           -- jti claim in refresh JWT
 *     user_id      CHAR(36) NOT NULL,
 *     token_hash   CHAR(64) NOT NULL,              -- sha256 of the raw token
 *     issued_at    DATETIME NOT NULL,
 *     expires_at   DATETIME NOT NULL,
 *     revoked_at   DATETIME NULL,
 *     replaced_by  CHAR(36) NULL,                  -- points to next-gen token
 *     INDEX (user_id),
 *     INDEX (expires_at)
 *   );
 *
 * Invariants:
 *   - Only a token_hash is stored — the raw token exists only in memory and
 *     is handed to the client.
 *   - On rotation, the old row's revoked_at is set + replaced_by points to the
 *     new row. Presenting a revoked-not-yet-expired token is a security event
 *     (log + return AUTH_INVALID_REFRESH).
 *
 * This file is a thin API. Actual SQL lives in modules/auth/repository.ts
 * (not implemented in step-one). Exposed here so infra tests can build against it.
 * ==============================================================================
 */
import { sha256 } from '../utils/crypto.js';

/** Store a token by its sha256 — the raw token never touches the DB. */
export function hashForStorage(rawToken: string): string {
  return sha256(rawToken);
}
