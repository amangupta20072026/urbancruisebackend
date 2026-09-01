/**
 * ==============================================================================
 * Identity — the authenticated caller
 * ==============================================================================
 * Populated by `authenticate` middleware from a verified JWT. Attached to
 * req.identity AND stored in AsyncLocalStorage (so services / repositories
 * can read it without threading it through every function signature).
 * ==============================================================================
 */
import type { UserRole, SubRole } from '../rbac/roles.js';

export type Identity = {
  /** Stable user identifier — one row in the users table. */
  userId: string;
  /** Top-level role. All four are typed; non-customer roles are rejected at the auth guard until their features ship. */
  role: UserRole;
  /** Sub-role for corporate customers / vendor staff; null otherwise. */
  subRole: SubRole;
  /**
   * The tenant column value for this user's role:
   *   customer → customer_id
   *   vendor   → vendor_id
   *   driver   → driver_id
   *   uc       → uc_user_id
   */
  entityId: string;
};
