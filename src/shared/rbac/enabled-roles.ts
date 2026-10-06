/**
 * ==============================================================================
 * Enabled roles — the single source of truth for the ENABLED_ROLES gate
 * ==============================================================================
 * ENABLED_ROLES (env, comma-separated, default 'customer') switches whole
 * user types on per environment, without a code change.
 *
 * It is enforced at EVERY door, not just one (fix H2):
 *   • authenticate middleware        — normal API calls
 *   • POST /auth/otp/request         — no SMS is sent for a disabled role
 *   • POST /auth/otp/verify          — no session is created
 *   • POST /auth/customer/onboard    — no customer row / session is created
 *   • POST /auth/refresh             — an existing session cannot be kept alive
 *
 * Before H2 this function existed but NOTHING called it: only the
 * authenticate middleware checked the role (with its own private copy of the
 * set), so a "disabled" vendor/driver/staff number still got a real (paid)
 * SMS, a real DB session, and endless refreshes — only their API calls were
 * refused.
 *
 * The auth services receive the set through AuthServiceDeps.enabledRoles
 * (default: ENABLED_ROLE_SET), so tests can switch roles without env vars.
 * ==============================================================================
 */
import { ENV } from '../../config/env.js';
import { ForbiddenError } from '../errors/index.js';
import type { UserRole } from './roles.js';

/** Roles enabled on this environment, parsed once at boot. */
// ENV.ENABLED_ROLES is validated in config/env.ts — every entry is a real
// role, so no cast is needed.
export const ENABLED_ROLE_SET: ReadonlySet<UserRole> = new Set<UserRole>(ENV.ENABLED_ROLES);

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
