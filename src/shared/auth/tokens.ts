/**
 * Refresh tokens are stored only as a SHA-256 hash
 * (auth_sessions.refresh_token_hash), never in raw form.
 */
import { sha256 } from '../utils/crypto.js';

export function hashForStorage(rawToken: string): string {
  return sha256(rawToken);
}
