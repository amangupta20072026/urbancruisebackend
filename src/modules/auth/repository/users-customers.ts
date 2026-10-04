/**
 * ==============================================================================
 * auth.repository — customer user resolution, creation + profile loading
 * ==============================================================================
 * Handles the `customers` table (shared with the web CRM):
 *   • findCustomerByPhone        — phone lookup (production format first)
 *   • createCustomerIfAbsent     — called ONLY after onboarding is submitted;
 *                                  serialised per mobile so no duplicate rows
 *   • getCustomerStatusById      — existence check for refresh / me
 *   • loadCustomerProfile        — profile DTO for the login response
 *   • loadCustomerIdentityDetails — profile + requiresProfileSetup for /me
 *
 * NOTES
 *   • `customers` has no `status` column — an existing row is always active.
 *     Blocking a customer is done with mobile_registry.admin_blocked.
 *   • `customerPhone` has no UNIQUE index (the CRM already holds duplicates),
 *     so creation is protected by a MySQL named lock instead.
 *   • `created_at` is nullable — CRM rows may not have it.
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader, PoolConnection } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import { logger } from '../../../shared/logger/index.js';
import { maskMobile } from '../../../shared/utils/phone.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';
import { CUSTOMER_CREATE_LOCK_TIMEOUT_SECONDS } from '../../../config/constants.js';
import type { CustomerOnboardingDetails, ResolvedUser, UserProfileDto } from '../types.js';
import {
  candidateFormats,
  placeholders,
  toDbPhone,
  joinName,
  normalisePhoneToE164,
  placeholder,
} from './users-shared.js';

/* --------------------------------------------------------------------------
 * DB row shape
 * -------------------------------------------------------------------------- */
type CustomerRow = RowDataPacket & {
  id: number;
  customerPhone: string;
  customerEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  created_at: Date | null;
};

type Runner = Pick<PoolConnection, 'execute'>;

function toResolved(r: CustomerRow): ResolvedUser {
  return {
    role: 'customer',
    entityId: String(r.id),
    userId: String(r.id),
    subRole: null,
    status: 'active',
    requiresProfileSetup: !r.firstName || r.firstName.trim() === '',
  };
}

/* --------------------------------------------------------------------------
 * Phone lookup
 * --------------------------------------------------------------------------
 * When the CRM holds several rows for one number, the OLDEST row wins
 * (stable, and it is normally the original record bookings hang off).
 * Duplicates are logged so ops can merge them.
 * -------------------------------------------------------------------------- */
async function findWith(runner: Runner, mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const [rows] = await runner.execute<CustomerRow[]>(
    `SELECT id, firstName
       FROM customers
      WHERE customerPhone IN (${placeholders(fmts)})
      ORDER BY id ASC
      LIMIT 2`,
    fmts,
  );
  if (!rows.length) return null;
  if (rows.length > 1) {
    logger.warn(
      {
        alarm: 'duplicate_customer_phone',
        mobile: maskMobile(mobile),
        customerIds: rows.map(r => r.id),
      },
      'several customers share this phone — logging into the oldest',
    );
  }
  return toResolved(rows[0]!);
}

export function findCustomerByPhone(mobile: string): Promise<ResolvedUser | null> {
  return findWith(pool, mobile);
}

/* --------------------------------------------------------------------------
 * Creation — ONLY after onboarding details are submitted
 * --------------------------------------------------------------------------
 * 1. Take a per-mobile MySQL named lock (same connection for the whole flow).
 * 2. Re-check: if the number now exists (double submit, or the CRM created
 *    it meanwhile) return THAT row — never insert a duplicate.
 * 3. Insert with the production phone format.
 * 4. Release the lock.
 * -------------------------------------------------------------------------- */
export async function createCustomerIfAbsent(
  mobile: string,
  details: CustomerOnboardingDetails,
): Promise<{ user: ResolvedUser; created: boolean }> {
  const dbPhone = toDbPhone(mobile);
  const lockName = `uc:customer:create:${dbPhone.slice(-10)}`;
  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS got', [
      lockName,
      CUSTOMER_CREATE_LOCK_TIMEOUT_SECONDS,
    ]);
    if (Number(lockRows[0]?.['got']) !== 1) {
      throw new ServiceUnavailableError(
        'We are busy setting up your account. Please try again.',
        'CUSTOMER_CREATE_BUSY',
      );
    }
    try {
      const existing = await findWith(conn, mobile);
      if (existing) return { user: existing, created: false };

      const [result] = await conn.execute<ResultSetHeader>(
        `INSERT INTO customers (uuid, customerPhone, firstName, lastName, customerEmail, countryName)
         VALUES (UUID(), ?, ?, ?, ?, 'India')`,
        [dbPhone, details.firstName, details.lastName, details.email],
      );
      const id = String(result.insertId);
      return {
        user: {
          role: 'customer',
          entityId: id,
          userId: id,
          subRole: null,
          status: 'active',
          requiresProfileSetup: false,
        },
        created: true,
      };
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    conn.release();
  }
}

/* --------------------------------------------------------------------------
 * Status by id — used on refresh and /me
 * -------------------------------------------------------------------------- */
export async function getCustomerStatusById(id: string): Promise<ResolvedUser['status'] | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM customers WHERE id = ? LIMIT 1',
    [id],
  );
  return rows.length ? 'active' : null;
}

/* --------------------------------------------------------------------------
 * Profile loaders
 * -------------------------------------------------------------------------- */
function toProfile(r: CustomerRow): UserProfileDto {
  const phone = normalisePhoneToE164(r.customerPhone ?? '');
  return {
    id: String(r.id),
    displayName: joinName(r.firstName, r.lastName) || 'New customer',
    email: r.customerEmail ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: (r.created_at ?? new Date()).toISOString(),
  };
}

async function loadRow(id: string): Promise<CustomerRow | null> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, customerEmail, firstName, lastName, created_at
       FROM customers WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function loadCustomerProfile(id: string): Promise<UserProfileDto> {
  const r = await loadRow(id);
  return r ? toProfile(r) : placeholder(id);
}

export async function loadCustomerIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const r = await loadRow(id);
  if (!r) return null;
  return { profile: toProfile(r), requiresProfileSetup: toResolved(r).requiresProfileSetup };
}
