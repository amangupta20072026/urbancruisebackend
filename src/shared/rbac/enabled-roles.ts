/**
 * Gate for ENABLED_ROLES. Checked in authenticate, OTP request, OTP verify,
 * customer onboarding and token refresh, so a disabled role gets no SMS, no
 * session and no API access. Auth services receive the set via
 * AuthServiceDeps.enabledRoles.
 */
import { ENV } from '../../config/env.js';
import { ForbiddenError } from '../errors/index.js';
import type { UserRole } from './roles.js';

/** Roles enabled on this environment (already validated in env.ts). */
export const ENABLED_ROLE_SET: ReadonlySet<UserRole> = new Set<UserRole>(ENV.ENABLED_ROLES);

/** Throws 403 ROLE_NOT_ENABLED if the role is not enabled. */
export function assertRoleEnabled(enabled: ReadonlySet<UserRole>, role: UserRole): void {
  if (!enabled.has(role)) {
    throw new ForbiddenError(
      `Role '${role}' is not enabled on this environment yet.`,
      'ROLE_NOT_ENABLED',
      { role },
    );
  }
}
