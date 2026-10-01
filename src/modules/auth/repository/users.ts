/**
 * ==============================================================================
 * auth.repository — user resolution + profile loading
 * ==============================================================================
 * Handles the four role tables:
 *   • customers   (self-signup on first login)
 *   • vendors     (must be pre-provisioned; sub-role from which phone col matched)
 *   • drivers     (must be pre-provisioned)
 *   • uc_staff    (must be pre-provisioned)
 *
 * Exposes:
 *   findUserByPhone(role, mobile)    — dispatches to per-role finder; used by
 *                                       both send + verify OTP flows.
 *   findCustomerByPhone / findVendorByPhone / findDriverByPhone /
 *   findUcStaffByPhone               — direct per-role finders (kept exported
 *                                       for tests and future callers).
 *   createCustomerShell(mobile)      — customer auto-provisioning on first login.
 *   loadProfile(role, entityId)      — used by verify's response DTO.
 *   loadIdentityDetails(role, id)    — used by /auth/me; returns null when
 *                                       the entity row has vanished.
 *
 * Phone normalisation lives in the service layer (shared/utils/phone.ts).
 * This layer accepts the mobile string it's given and queries with candidate
 * formats to tolerate legacy row shapes.
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { ResolvedUser, UserProfileDto } from '../types.js';
import type { UserRole, SubRole } from '../../../shared/rbac/roles.js';

/* -----------------------------------------------------------------
 * Candidate phone formats
 * -----------------------------------------------------------------
 * The four DB phone columns can be stored in any of three formats we've
 * seen in the wild:
 *   '9812345678'     — bare 10 digits
 *   '919812345678'   — E.164 without '+'
 *   '+919812345678'  — E.164 with '+'
 * We query all three shapes at once via IN(). Cheap — at most 3 index seeks.
 * ----------------------------------------------------------------- */
function candidateFormats(mobile: string): string[] {
  const withoutCc = mobile.replace(/^91/, '');
  return [mobile, `+${mobile}`, withoutCc];
}

/* ==============================================================================
 * Public dispatcher — used by service/otp-send + service/otp-verify
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

/* ==============================================================================
 * Customer
 * ============================================================================== */

type CustomerRow = RowDataPacket & {
  id: number;
  customerPhone: string;
  customerEmail: string | null;
  firstName: string | null;
  lastName: string | null;
  created_at: Date;
};

export async function findCustomerByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  // NOTE: `customers` table has no `status` or `signup_completed_at` columns.
  // Status checks are skipped for customers (treated as always 'active').
  // Profile-setup completeness is inferred from `firstName IS NULL`.
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

/**
 * Create a shell customer row on first login. Only customerPhone is set;
 * every other field is NULL until CompleteProfile fills them in.
 */
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

/* ==============================================================================
 * Vendor — sub-role derived from which phone column matched
 * ============================================================================== */

type VendorRow = RowDataPacket & {
  id: number;
  phone: string | null;
  owner_phone: string | null;
  manager_phone1: string | null;
  manager_phone2: string | null;
  status: string | null;
};

export async function findVendorByPhone(mobile: string): Promise<ResolvedUser | null> {
  const [f1, f2, f3] = candidateFormats(mobile) as [string, string, string];
  const [rows] = await pool.execute<VendorRow[]>(
    `SELECT id, phone, owner_phone, manager_phone1, manager_phone2, status
       FROM vendors
      WHERE phone          IN (?, ?, ?)
         OR owner_phone    IN (?, ?, ?)
         OR manager_phone1 IN (?, ?, ?)
         OR manager_phone2 IN (?, ?, ?)
      ORDER BY id ASC
      LIMIT 1`,
    [f1, f2, f3, f1, f2, f3, f1, f2, f3, f1, f2, f3],
  );
  if (!rows.length) return null;
  const v = rows[0]!;
  const subRole = deriveVendorSubRole(v, [f1, f2, f3]);
  return {
    role: 'vendor',
    entityId: String(v.id),
    userId: String(v.id),
    subRole,
    status: normStatus(v.status),
    requiresProfileSetup: false,
  };
}

function deriveVendorSubRole(v: VendorRow, fmts: string[]): SubRole {
  const match = (col: string | null) => col !== null && fmts.includes(col);
  if (match(v.owner_phone) || match(v.phone)) return 'owner';
  if (match(v.manager_phone1)) return 'bookingManager';
  if (match(v.manager_phone2)) return 'opsManager';
  return 'owner'; // safe default
}

/* ==============================================================================
 * Driver
 * ============================================================================== */

type DriverRow = RowDataPacket & {
  id: number;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  created_at: Date;
};

export async function findDriverByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  // NOTE: `drivers` table has no `status` column. Status checks are skipped
  // for drivers (treated as always 'active').
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

/* ==============================================================================
 * UC staff
 * ============================================================================== */

type UcStaffRow = RowDataPacket & {
  id: number;
  full_name: string;
  email: string | null;
  mobile: string;
  department: string;
  status: 'active' | 'suspended' | 'left';
  created_at: Date;
};

export async function findUcStaffByPhone(mobile: string): Promise<ResolvedUser | null> {
  const fmts = candidateFormats(mobile);
  const [rows] = await pool.execute<UcStaffRow[]>(
    `SELECT id, mobile, status FROM uc_staff WHERE mobile IN (?, ?, ?) LIMIT 1`,
    fmts,
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    role: 'uc',
    entityId: String(r.id),
    userId: String(r.id),
    subRole: null,
    status: normStatus(r.status),
    requiresProfileSetup: false,
  };
}

function normStatus(s: string | null): ResolvedUser['status'] {
  if (s === 'active' || s === 'suspended' || s === 'deleted') return s;
  return s === null ? 'active' : 'other';
}

/* ==============================================================================
 * PROFILE FETCHERS (for /verify response + /me)
 * ============================================================================== */

export async function loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto> {
  switch (role) {
    case 'customer':
      return loadCustomerProfile(entityId);
    case 'driver':
      return loadDriverProfile(entityId);
    case 'vendor':
      return loadVendorProfile(entityId);
    case 'uc':
      return loadUcStaffProfile(entityId);
  }
}

/**
 * /auth/me loader — returns profile + a fresh `requiresProfileSetup` computed
 * from the same DB read, or `null` if the entity row no longer exists.
 *
 * Why not reuse `loadProfile`?
 *   - `loadProfile` falls back to a placeholder DTO when the row is missing
 *     (safe for the login response). For /me the caller must distinguish
 *     "gone → revoke session" from "here → land on Home", so we need `null`
 *     as a first-class signal.
 *   - We also need `requiresProfileSetup` alongside the profile. Rolling
 *     both into one query per role avoids a second round-trip.
 */
export async function loadIdentityDetails(
  role: UserRole,
  entityId: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  switch (role) {
    case 'customer':
      return loadCustomerIdentityDetails(entityId);
    case 'driver':
      return loadDriverIdentityDetails(entityId);
    case 'vendor':
      return loadVendorIdentityDetails(entityId);
    case 'uc':
      return loadUcStaffIdentityDetails(entityId);
  }
}

async function loadCustomerIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, customerEmail, firstName, lastName, created_at
       FROM customers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0]!;
  const display = joinName(r.firstName, r.lastName) || 'New customer';
  const phone = normalisePhoneToE164(r.customerPhone);
  return {
    profile: {
      id: String(r.id),
      displayName: display,
      email: r.customerEmail ?? null,
      phoneIndia: phone,
      phoneGlobal: phone,
      memberSince: r.created_at.toISOString(),
    },
    requiresProfileSetup: r.firstName === null,
  };
}

async function loadDriverIdentityDetails(
  id: string,
): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
  const profile = await loadDriverProfile(id);
  const [rows] = await pool.execute<DriverRow[]>(`SELECT id FROM drivers WHERE id = ? LIMIT 1`, [
    id,
  ]);
  if (!rows.length) return null;
  return { profile, requiresProfileSetup: false };
}

async function loadVendorIdentityDetails(
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

async function loadUcStaffIdentityDetails(
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

async function loadCustomerProfile(id: string): Promise<UserProfileDto> {
  const [rows] = await pool.execute<CustomerRow[]>(
    `SELECT id, customerPhone, customerEmail, firstName, lastName, created_at
       FROM customers WHERE id = ? LIMIT 1`,
    [id],
  );
  if (!rows.length) return placeholder(id);
  const r = rows[0]!;
  const display = joinName(r.firstName, r.lastName) || 'New customer';
  const phone = normalisePhoneToE164(r.customerPhone);
  return {
    id: String(r.id),
    displayName: display,
    email: r.customerEmail ?? null,
    phoneIndia: phone,
    phoneGlobal: phone,
    memberSince: r.created_at.toISOString(),
  };
}

async function loadDriverProfile(id: string): Promise<UserProfileDto> {
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

async function loadVendorProfile(id: string): Promise<UserProfileDto> {
  type VendorProfileRow = RowDataPacket & {
    id: number;
    name: string | null;
    email: string | null;
    phone: string | null;
    owner_name: string | null;
    created_at: Date;
  };
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
    memberSince: r.created_at.toISOString(),
  };
}

async function loadUcStaffProfile(id: string): Promise<UserProfileDto> {
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

/* -----------------------------------------------------------------
 * Local helpers
 * -----------------------------------------------------------------
 * These are DB-projection helpers, not phone-domain primitives —
 * `normalisePhoneToE164` here reads any of the three storage shapes we
 * accept and produces the '+91...' display string used in the profile
 * DTO. The service-layer `normalizeMobile` in shared/utils/phone.ts
 * produces the internal (no-plus) shape used for keying. Different jobs
 * with unfortunately similar names; kept local so they don't get mixed.
 * ----------------------------------------------------------------- */

function joinName(a: string | null, b: string | null): string {
  return [a, b].filter(Boolean).join(' ').trim();
}

function normalisePhoneToE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}

function placeholder(id: string): UserProfileDto {
  return {
    id,
    displayName: 'User',
    email: null,
    phoneIndia: '',
    phoneGlobal: '',
    memberSince: new Date().toISOString(),
  };
}
