/**
 * ==============================================================================
 * auth.repository — driver user resolution + profile loading
 * ==============================================================================
 * Handles the `drivers` table:
 *   • findDriverByPhone        — phone lookup
 *   • loadDriverProfile        — profile DTO for /verify response
 *   • loadDriverIdentityDetails — profile + requiresProfileSetup for /me
 *                                 returns null when the row has vanished
 *
 * NOTE: `drivers` has no `status` column — status is always 'active'.
 * ==============================================================================
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { ResolvedUser, UserProfileDto } from '../types.js';
import { candidateFormats, joinName, normalisePhoneToE164, placeholder } from './users-shared.js';

/* --------------------------------------------------------------------------
 * DB row shape
 * -------------------------------------------------------------------------- */
type DriverRow = RowDataPacket & {
  id: number;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: Date;
};

/* --------------------------------------------------------------------------
 * Phone lookup
 * -------------------------------------------------------------------------- */
export async function findDriverByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  // NOTE: `drivers` table has no `status` column.
  const [rows] = await pool.execute<DriverRow[]>(
    `SELECT id, phone
       FROM drivers
      WHERE phone IN (?, ?, ?)
      LIMIT 1`,
    fmts,
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    role: 'driver',
    entityId: String(r.id),
    userId: String(r.id),
    subRole: null,
    status: 'active',
    requiresProfileSetup: false,
  };
}

/* --------------------------------------------------------------------------
 * Profile loaders
 * -------------------------------------------------------------------------- */
export async function loadDriverProfile(id: string): Promise<UserProfileDto> {
  const [rows] = await pool.execute<DriverRow[]>(
    `SELECT id, phone, first_name, last_name, email, created_at
       FROM drivers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return placeholder(id);
  const r = rows[0]!;
  const phone = normalisePhoneToE164(r.phone);
  return {
    id: String(r.id),
    displayName: joinName(r.first_name, r.last_name) || 'Driver',
    email: r.email ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: r.created_at.toISOString(),
  };
}

export async function loadDriverIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const profile = await loadDriverProfile(id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM drivers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  return { profile, requiresProfileSetup: false };
}
