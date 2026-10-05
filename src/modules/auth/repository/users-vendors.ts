/**
 * ==============================================================================
 * auth.repository — vendor user resolution + profile loading
 * ==============================================================================
 * Handles the `vendors` table:
 *   • findVendorByPhone        — phone lookup across 4 phone columns
 *   • loadVendorProfile        — profile DTO for /verify response
 *   • loadVendorIdentityDetails — profile + requiresProfileSetup for /me
 *                                 returns null when the row has vanished
 *
 * Sub-role derivation:
 *   owner_phone / phone → 'owner'
 *   manager_phone1      → 'bookingManager'
 *   manager_phone2      → 'opsManager'
 * ==============================================================================
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { ResolvedUser, UserProfileDto } from '../types.js';
import type { VendorSubRole } from '../../../shared/rbac/roles.js';
import {
  candidateFormats,
  placeholders,
  normalisePhoneToE164,
  placeholder,
  normStatus,
} from './users-shared.js';
import { VENDOR_NULL_STATUS_IS_ACTIVE } from '../../../config/constants.js';
import { logger } from '../../../shared/logger/index.js';
import { maskMobile } from '../../../shared/utils/phone.js';

/* --------------------------------------------------------------------------
 * DB row shapes
 * -------------------------------------------------------------------------- */
type VendorRow = RowDataPacket & {
  id: number;
  phone: string | null;
  owner_phone: string | null;
  manager_phone1: string | null;
  manager_phone2: string | null;
  status: string | null;
};

type VendorProfileRow = RowDataPacket & {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  owner_name: string | null;
  created_at: Date | null;
};

/* --------------------------------------------------------------------------
 * Phone lookup
 * -------------------------------------------------------------------------- */
export async function findVendorByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const inList = placeholders(fmts);
  const [rows] = await pool.execute<VendorRow[]>(
    `SELECT id, phone, owner_phone, manager_phone1, manager_phone2, status
       FROM vendors
      WHERE phone          IN (${inList})
         OR owner_phone    IN (${inList})
         OR manager_phone1 IN (${inList})
         OR manager_phone2 IN (${inList})
      ORDER BY id ASC
      LIMIT 1`,
    [...fmts, ...fmts, ...fmts, ...fmts],
  );
  if (!rows.length) return null;
  const v = rows[0]!;
  const subRole = deriveVendorSubRole(v, mobile);
  if (subRole === null) {
    // SQL matched the row but no column clearly identifies this phone's
    // role. Refuse rather than guess — see deriveVendorSubRole.
    logger.error(
      { alarm: 'vendor_subrole_unresolved', vendorId: v.id, mobile: maskMobile(mobile) },
      'vendor login refused — phone matched in SQL but no role column matched; check the stored phone values',
    );
    return null;
  }
  return {
    role: 'vendor',
    entityId: String(v.id),
    userId: String(v.id),
    subRole,
    status: normStatus(v.status, { nullIsActive: VENDOR_NULL_STATUS_IS_ACTIVE }),
    requiresProfileSetup: false,
  };
}

/**
 * Which vendor role does `mobile` hold on this row? (audit fix #12)
 *
 * Compares DIGITS (last 10), not raw strings. MySQL matched the row with its
 * own collation rules — trailing spaces and case are ignored — so a stored
 * value like '9812345678 ' passes the SQL lookup but fails an exact
 * JavaScript comparison. The old code then fell through to a "safe default"
 * of 'owner', the MOST privileged vendor role: a manager with a stray space
 * in their stored number became an owner.
 *
 * Now: precedence owner > bookingManager > opsManager (unchanged), and when
 * nothing matches the result is null, which the caller turns into a refused
 * login. Least privilege: never grant a role we cannot positively identify.
 */
export function deriveVendorSubRole(
  v: Pick<VendorRow, 'phone' | 'owner_phone' | 'manager_phone1' | 'manager_phone2'>,
  mobile: string,
): VendorSubRole | null {
  const target = last10(mobile);
  if (target === null) return null;
  const match = (col: string | null) => col !== null && last10(col) === target;
  if (match(v.owner_phone) || match(v.phone)) return 'owner';
  if (match(v.manager_phone1)) return 'bookingManager';
  if (match(v.manager_phone2)) return 'opsManager';
  return null;
}

/** Last 10 digits of a phone value, or null when it is not a phone. */
function last10(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/* --------------------------------------------------------------------------
 * Status by id — used on refresh and /me so a vendor deactivated in the web
 * app loses access at the next token refresh.
 *
 * Unlike customers / drivers / UC staff, this deliberately does NOT consult
 * mobile_registry.admin_blocked: one vendor row carries up to four phones
 * (phone, owner_phone, manager_phone1/2) and a session does not record which
 * of them logged in. "Any phone blocked ⇒ vendor inactive" would log the
 * owner out because one manager's number was blocked. To cut off a vendor,
 * set vendors.status; a blocked individual phone is still refused at its
 * next OTP login.
 * -------------------------------------------------------------------------- */
export async function getVendorStatusById(id: string): Promise<ResolvedUser['status'] | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, status FROM vendors WHERE id = ? LIMIT 1',
    [id],
  );
  if (!rows.length) return null;
  return normStatus((rows[0]!['status'] as string | null) ?? null, {
    nullIsActive: VENDOR_NULL_STATUS_IS_ACTIVE,
  });
}

/* --------------------------------------------------------------------------
 * Profile loaders
 * -------------------------------------------------------------------------- */
export async function loadVendorProfile(id: string): Promise<UserProfileDto> {
  const [rows] = await pool.execute<VendorProfileRow[]>(
    `SELECT id, name, email, phone, owner_name, created_at
       FROM vendors WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return placeholder(id);
  const r = rows[0]!;
  const phone = normalisePhoneToE164(String(r.phone ?? ''));
  return {
    id: String(r.id),
    displayName: String(r.name ?? r.owner_name ?? 'Vendor'),
    email: r.email ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: (r.created_at ?? new Date()).toISOString(),
  };
}

export async function loadVendorIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const profile = await loadVendorProfile(id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM vendors WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return { profile, requiresProfileSetup: false };
}
