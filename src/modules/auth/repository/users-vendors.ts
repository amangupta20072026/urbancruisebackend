/**
 * ==============================================================================
 * auth.repository — vendor user resolution + profile loading
 * ==============================================================================
 * Handles the `vendors` table:
 *   • findVendorByPhone        — phone lookup on `vendors.phone` ONLY
 *   • loadVendorProfile        — profile DTO for /verify response
 *   • loadVendorIdentityDetails — profile + requiresProfileSetup for /me
 *                                 returns null when the row has vanished
 *
 * Vendors log in with `vendors.phone` only. `owner_phone`, `manager_phone1`
 * and `manager_phone2` are NOT login numbers. There is no vendor sub-role.
 * ==============================================================================
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { ResolvedUser, UserProfileDto } from '../types.js';
import {
  candidateFormats,
  placeholders,
  normalisePhoneToE164,
  placeholder,
  normStatus,
} from './users-shared.js';
import { VENDOR_NULL_STATUS_IS_ACTIVE } from '../../../config/constants.js';

/* --------------------------------------------------------------------------
 * DB row shapes
 * -------------------------------------------------------------------------- */
type VendorRow = RowDataPacket & {
  id: number;
  phone: string | null;
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
 * Phone lookup — `vendors.phone` only
 * -------------------------------------------------------------------------- */
export async function findVendorByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const [rows] = await pool.execute<VendorRow[]>(
    `SELECT id, phone, status
       FROM vendors
      WHERE phone IN (${placeholders(fmts)})
      ORDER BY id ASC
      LIMIT 1`,
    fmts,
  );
  if (!rows.length) return null;
  const v = rows[0]!;
  return {
    role: 'vendor',
    entityId: String(v.id),
    userId: String(v.id),
    status: normStatus(v.status, { nullIsActive: VENDOR_NULL_STATUS_IS_ACTIVE }),
    requiresProfileSetup: false,
  };
}

/* --------------------------------------------------------------------------
 * Status by id — used on refresh and /me so a vendor deactivated in the web
 * app loses access at the next token refresh.
 *
 * Unlike customers / drivers / UC staff, this does NOT consult
 * mobile_registry.admin_blocked. To cut off a vendor, set vendors.status;
 * a blocked phone is still refused at its next OTP login.
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
