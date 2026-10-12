/**
 * Refresh tokens are stored only as a SHA-256 hash
 * (auth_sessions.refresh_token_hash), never in raw form.
 */
import { sha256 } from '../utils/crypto.js';

/**
 * Hashes a raw token for storage in the database. The raw token is never stored
 * in the database, only its hash.
 */
export function hashForStorage(rawToken: string): string {
  return sha256(rawToken);
}
