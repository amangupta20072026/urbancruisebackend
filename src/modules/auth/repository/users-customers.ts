/**
 * ==============================================================================
 * auth.repository — customer user resolution + profile loading
 * ==============================================================================
 * Handles the `customers` table:
 *   • findCustomerByPhone  — phone lookup (3-format IN query)
 *   • createCustomerShell  — auto-provisioning on first OTP verify
 *   • loadCustomerProfile  — profile DTO for /verify response
 *   • loadCustomerIdentityDetails — profile + requiresProfileSetup for /me
 *                                   returns null when the row has vanished
 *
 * NOTE: `customers` has no `status` column — status is always 'active'.
 * Profile-setup completeness is inferred from `firstName IS NULL`.
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { ResolvedUser, UserProfileDto } from '../types.js';
import { candidateFormats, joinName, normalisePhoneToE164, placeholder } from './users-shared.js';

/* --------------------------------------------------------------------------
 * DB row shape
 * -------------------------------------------------------------------------- */
type CustomerRow = RowDataPacket & {
  id: number;
  customerPhone: string;
  customerEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  created_at: Date;
};

/* --------------------------------------------------------------------------
 * Phone lookup
 * -------------------------------------------------------------------------- */
export async function findCustomerByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, firstName
       FROM customers
      WHERE customerPhone IN (?, ?, ?)
      ORDER BY id ASC
      LIMIT 1`,
    fmts,
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    role: 'customer',
    entityId: String(r.id),
    userId: String(r.id),
    subRole: null,
    status: 'active',
    requiresProfileSetup: r.firstName === null,
  };
}

/* --------------------------------------------------------------------------
 * Auto-provisioning
 * -------------------------------------------------------------------------- */
export async function createCustomerShell(mobile: string): Promise<ResolvedUser> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO customers (customerPhone) VALUES (?)`,
    [mobile],
  );
  return {
    role: 'customer',
    entityId: String(result.insertId),
    userId: String(result.insertId),
    subRole: null,
    status: 'active',
    requiresProfileSetup: true,
  };
}

/* --------------------------------------------------------------------------
 * Profile loaders
 * -------------------------------------------------------------------------- */
export async function loadCustomerProfile(id: string): Promise<UserProfileDto> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, customerEmail, firstName, lastName, created_at
       FROM customers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return placeholder(id);
  const r = rows[0]!;
  const phone = normalisePhoneToE164(r.customerPhone);
  return {
    id: String(r.id),
    displayName: joinName(r.firstName, r.lastName) || 'New customer',
    email: r.customerEmail ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: r.created_at.toISOString(),
  };
}

export async function loadCustomerIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, customerEmail, firstName, lastName, created_at
       FROM customers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  const phone = normalisePhoneToE164(r.customerPhone);
  return {
    profile: {
      id: String(r.id),
      displayName: joinName(r.firstName, r.lastName) || 'New customer',
      email: r.customerEmail ?? null,
      phoneIndia: phone,
      phoneGlobal: phone,
      memberSince: r.created_at.toISOString(),
    },
    requiresProfileSetup: r.firstName === null,
  };
}
