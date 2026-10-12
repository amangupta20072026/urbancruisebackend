/** The authenticated caller, built from the access token by authenticate. */
import type { UserRole } from '../rbac/roles.js';

export type Identity = {
  /** Row id in the role's table (customers, vendors, drivers or uc_staff). */
  userId: string;
  role: UserRole;
  /** Currently the same value as userId. */
  entityId: string;
  /** auth_sessions jti. Used by logout and the revocation check. */
  sessionId: string;
};
