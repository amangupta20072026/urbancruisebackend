/**
 * Vendor sub-role derivation — audit item #12.
 * Before the fix, any phone that matched in SQL but not in the exact JS
 * comparison (e.g. a stored value with a trailing space) silently became
 * 'owner' — the most privileged vendor role.
 */
import { describe, it, expect } from 'vitest';
import { deriveVendorSubRole } from '../repository/users-vendors.js';

const LOGIN = '919812345678';
const row = (
  o: Partial<Record<'phone' | 'owner_phone' | 'manager_phone1' | 'manager_phone2', string | null>>,
) => ({
  phone: null,
  owner_phone: null,
  manager_phone1: null,
  manager_phone2: null,
  ...o,
});

describe('deriveVendorSubRole', () => {
  it('owner_phone / phone → owner', () => {
    expect(deriveVendorSubRole(row({ owner_phone: '+91 9812345678' }), LOGIN)).toBe('owner');
    expect(deriveVendorSubRole(row({ phone: '9812345678' }), LOGIN)).toBe('owner');
  });

  it('manager_phone1 → bookingManager, manager_phone2 → opsManager', () => {
    expect(deriveVendorSubRole(row({ manager_phone1: '919812345678' }), LOGIN)).toBe(
      'bookingManager',
    );
    expect(deriveVendorSubRole(row({ manager_phone2: '+919812345678' }), LOGIN)).toBe('opsManager');
  });

  it('REGRESSION: a manager stored with stray spaces stays a manager (was: owner)', () => {
    expect(deriveVendorSubRole(row({ manager_phone1: '9812345678 ' }), LOGIN)).toBe(
      'bookingManager',
    );
    expect(deriveVendorSubRole(row({ manager_phone2: ' +91 98123 45678 ' }), LOGIN)).toBe(
      'opsManager',
    );
  });

  it('REGRESSION: no matching column → null (login refused), never owner', () => {
    expect(deriveVendorSubRole(row({ owner_phone: '9800000000' }), LOGIN)).toBeNull();
    expect(deriveVendorSubRole(row({}), LOGIN)).toBeNull();
  });

  it('owner wins when the same phone is in several columns', () => {
    expect(
      deriveVendorSubRole(row({ owner_phone: '9812345678', manager_phone1: '9812345678' }), LOGIN),
    ).toBe('owner');
  });

  it('garbage input never matches', () => {
    expect(deriveVendorSubRole(row({ owner_phone: 'n/a' }), LOGIN)).toBeNull();
    expect(deriveVendorSubRole(row({ owner_phone: '9812345678' }), 'abc')).toBeNull();
  });
});
