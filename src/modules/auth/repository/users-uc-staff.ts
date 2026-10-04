/**
 * ==============================================================================
 * auth.repository — UC staff user resolution + profile loading
 * ==============================================================================
 * Handles the `uc_staff` table:
 *   • findUcStaffByPhone        — phone lookup
 *   • loadUcStaffProfile        — profile DTO for /verify response
 *   • loadUcStaffIdentityDetails — profile + requiresProfileSetup for /me
 *                                  returns null when the row has vanished
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

/* --------------------------------------------------------------------------
 * DB row shape
 * -------------------------------------------------------------------------- */
type UcStaffRow = RowDataPacket & {
  id: number;
  full_name: string;
  email: string | null;
  mobile: string;
  department: string;
  status: 'active' | 'suspended' | 'left';
  created_at: Date;
};

/* --------------------------------------------------------------------------
 * Phone lookup
 * -------------------------------------------------------------------------- */
export async function findUcStaffByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const [rows] = await pool.execute<UcStaffRow[]>(
    `SELECT id, mobile, status FROM uc_staff WHERE mobile IN (${placeholders(fmts)}) LIMIT 1`,
    fmts,
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    role: 'uc',
    entityId: String(r.id),
    userId: String(r.id),
    subRole: null,
    status: normStatus(r.status, { nullIsActive: false }),
    requiresProfileSetup: false,
  };
}

/* --------------------------------------------------------------------------
 * Status by id — 'active' only; 'suspended' and 'left' are inactive.
 * -------------------------------------------------------------------------- */
export async function getUcStaffStatusById(id: string): Promise<ResolvedUser['status'] | null> {
  const [rows] = await pool.execute<UcStaffRow[]>(
    'SELECT id, status FROM uc_staff WHERE id = ? LIMIT 1',
    [id],
  );
  if (!rows.length) return null;
  return normStatus(rows[0]!.status, { nullIsActive: false });
}

/* --------------------------------------------------------------------------
 * Profile loaders
 * -------------------------------------------------------------------------- */
export async function loadUcStaffProfile(id: string): Promise<UserProfileDto> {
  const [rows] = await pool.execute<UcStaffRow[]>(
    `SELECT id, full_name, email, mobile, created_at
       FROM uc_staff WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return placeholder(id);
  const r = rows[0]!;
  const phone = normalisePhoneToE164(r.mobile);
  return {
    id: String(r.id),
    displayName: r.full_name,
    email: r.email ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: r.created_at.toISOString(),
  };
}

export async function loadUcStaffIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const profile = await loadUcStaffProfile(id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM uc_staff WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return { profile, requiresProfileSetup: false };
}
