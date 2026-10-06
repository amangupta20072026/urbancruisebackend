/**
 * ==============================================================================
 * Enabled roles — the single source of truth for the ENABLED_ROLES gate
 * ==============================================================================
 * ENABLED_ROLES (env, comma-separated, default 'customer') switches whole
 * user types on per environment, without a code change.
 *
 * It must be enforced at EVERY door, not just one (fix N2):
 *   • authenticate middleware  — normal API calls
 *   • POST /auth/otp/request   — no SMS is sent for a disabled role
 *   • POST /auth/otp/verify    — no session is created
 *   • POST /auth/refresh       — an existing session cannot be kept alive
 * Before, only the first existed: a "disabled" vendor/driver/staff number
 * still got a real (paid) SMS, a real DB session, and endless refreshes —
 * only their API calls were refused.
 * ==============================================================================
 */
import { ENV } from '../../config/env.js';
import { ForbiddenError } from '../errors/index.js';
import type { UserRole } from './roles.js';

/** Roles enabled on this environment, parsed once at boot. */
export const ENABLED_ROLE_SET: ReadonlySet<UserRole> = new Set(ENV.ENABLED_ROLES as UserRole[]);

/** Throws 403 ROLE_NOT_ENABLED when `role` is not in `enabled`. */
export function assertRoleEnabled(enabled: ReadonlySet<UserRole>, role: UserRole): void {
  if (!enabled.has(role)) {
    throw new ForbiddenError(
      `Role '${role}' is not enabled on this environment yet.`,
      'ROLE_NOT_ENABLED',
      { role },
    );
  }
}
