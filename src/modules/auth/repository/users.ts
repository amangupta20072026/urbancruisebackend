/**
 * auth repository: per-role dispatch for user lookup and profiles. SQL lives
 * in users-<role>.ts. To add a role, create that file and add a case to
 * each switch here.
 */
import type { ResolvedUser, UserProfileDto } from '../types.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

// Per-role implementations

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

// Used by the dispatchers

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

/* Dispatchers, used by MysqlAuthRepository */

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

/** Account status by id; null if the row is gone. Checked on refresh and /me. */
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
