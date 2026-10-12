/**
 * auth repository: customers (shared with the web CRM).
 * No status column: customers are blocked via mobile_registry.
 * customerPhone isn't unique (the CRM has duplicates), so creation uses a
 * MySQL named lock. created_at may be null on CRM rows.
 */
import type { RowDataPacket, ResultSetHeader, PoolConnection } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import { logger } from '../../../shared/logger/index.js';
import { maskMobile } from '../../../shared/utils/phone.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';
import { CUSTOMER_CREATE_LOCK_TIMEOUT_SECONDS } from '../../../config/constants.js';
import { isRawPhoneAdminBlocked } from './mobile-registry.js';
import type { CustomerOnboardingDetails, ResolvedUser, UserProfileDto } from '../types.js';
import {
  candidateFormats,
  placeholders,
  toDbPhone,
  joinName,
  normalisePhoneToE164,
  placeholder,
} from './users-shared.js';

/* DB row */
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
    status: 'active',
    requiresProfileSetup: !r.firstName || r.firstName.trim() === '',
  };
}

/* Phone lookup. With duplicates the oldest row wins; duplicates are logged for cleanup. */
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

/*
 * Creation, after onboarding only. Under a per-mobile named lock (one
 * connection throughout): re-check, return an existing row if found,
 * otherwise insert.
 */
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

/* Status by id (refresh, /me) */
export async function getCustomerStatusById(id: string): Promise<ResolvedUser['status'] | null> {
  // No status column: an admin block on the phone is the only deactivation.
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, customerPhone FROM customers WHERE id = ? LIMIT 1',
    [id],
  );
  if (!rows.length) return null;
  const blocked = await isRawPhoneAdminBlocked(rows[0]!['customerPhone'] as string | null);
  return blocked ? 'inactive' : 'active';
}

/* Profile loaders */
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
