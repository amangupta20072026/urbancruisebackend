/**
 * ==============================================================================
 * auth.repository — user resolution + profile loading (dispatcher)
 * ==============================================================================
 * This file is now a THIN DISPATCHER. All SQL and per-role logic lives in the
 * four role-specific files below. This file only:
 *   1. Re-exports the per-role finders/loaders so existing callers that import
 *      directly from `users.ts` continue to work unchanged.
 *   2. Implements `findUserByPhone`, `loadProfile`, and `loadIdentityDetails`
 *      as switch-on-role dispatchers — the only logic here is routing.
 *
 * ROLE FILES
 *   users-customers.ts  — customers table
 *   users-vendors.ts    — vendors table (sub-role derivation included)
 *   users-drivers.ts    — drivers table
 *   users-uc-staff.ts   — uc_staff table
 *   users-shared.ts     — candidateFormats, normStatus, normalisePhoneToE164,
 *                         joinName, placeholder (shared helpers)
 *
 * ADDING A NEW ROLE
 *   1. Create `users-<role>.ts` with findXByPhone / loadXProfile / loadXIdentityDetails.
 *   2. Add a case to each switch below.
 *   3. Re-export the finder/loader from this file.
 *   No changes needed in service files, ports, or tests.
 * ==============================================================================
 */
import type { ResolvedUser, UserProfileDto } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

// ── Per-role implementations ────────────────────────────────────────────────

export {
  findCustomerByPhone,
  createCustomerIfAbsent,
  getCustomerStatusById,
  loadCustomerProfile,
  loadCustomerIdentityDetails,
} from './users-customers.js';

export {
  findVendorByPhone,
  loadVendorProfile,
  loadVendorIdentityDetails,
} from './users-vendors.js';

export {
  findDriverByPhone,
  loadDriverProfile,
  loadDriverIdentityDetails,
} from './users-drivers.js';

export {
  findUcStaffByPhone,
  loadUcStaffProfile,
  loadUcStaffIdentityDetails,
} from './users-uc-staff.js';

// ── Role-agnostic imports for dispatchers ───────────────────────────────────

import {
  findCustomerByPhone,
  getCustomerStatusById,
  loadCustomerProfile,
  loadCustomerIdentityDetails,
} from './users-customers.js';
import {
  findVendorByPhone,
  getVendorStatusById,
  loadVendorProfile,
  loadVendorIdentityDetails,
} from './users-vendors.js';
import {
  findDriverByPhone,
  getDriverStatusById,
  loadDriverProfile,
  loadDriverIdentityDetails,
} from './users-drivers.js';
import {
  findUcStaffByPhone,
  getUcStaffStatusById,
  loadUcStaffProfile,
  loadUcStaffIdentityDetails,
} from './users-uc-staff.js';

/* ==============================================================================
 * Dispatchers — used by MysqlAuthRepository (IAuthRepository implementation)
 * ============================================================================== */

export async function findUserByPhone(
  role: UserRole,
  mobile: string,
): Promise<ResolvedUser | null> {
  switch (role) {
    case 'customer':
      return findCustomerByPhone(mobile);
    case 'vendor':
      return findVendorByPhone(mobile);
    case 'driver':
      return findDriverByPhone(mobile);
    case 'uc':
      return findUcStaffByPhone(mobile);
  }
}

export async function loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto> {
  switch (role) {
    case 'customer':
      return loadCustomerProfile(entityId);
    case 'vendor':
      return loadVendorProfile(entityId);
    case 'driver':
      return loadDriverProfile(entityId);
    case 'uc':
      return loadUcStaffProfile(entityId);
  }
}

export async function loadIdentityDetails(
  role: UserRole,
  entityId: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  switch (role) {
    case 'customer':
      return loadCustomerIdentityDetails(entityId);
    case 'vendor':
      return loadVendorIdentityDetails(entityId);
    case 'driver':
      return loadDriverIdentityDetails(entityId);
    case 'uc':
      return loadUcStaffIdentityDetails(entityId);
  }
}

/**
 * Current login status of an already-known account (by tenant id).
 * Returns null when the row no longer exists. Used on refresh and /me so
 * accounts disabled from the web app lose mobile access promptly.
 */
export async function getAccountStatus(
  role: UserRole,
  entityId: string,
): Promise<ResolvedUser['status'] | null> {
  switch (role) {
    case 'customer':
      return getCustomerStatusById(entityId);
    case 'vendor':
      return getVendorStatusById(entityId);
    case 'driver':
      return getDriverStatusById(entityId);
    case 'uc':
      return getUcStaffStatusById(entityId);
  }
}
