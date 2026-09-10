/**
 * ==============================================================================
 * auth — repository (SQL only)
 * ==============================================================================
 * Parameterised queries against:
 *   • customers          (self-signup on first login)
 *   • vendors            (must be pre-provisioned; sub-role from which phone col matched)
 *   • drivers            (must be pre-provisioned)
 *   • uc_staff           (must be pre-provisioned)
 *   • auth_sessions      (refresh-token sessions)
 *   • mobile_registry    (persistent per-mobile flags)
 *   • otp_events         (audit)
 *   • login_events       (audit)
 *
 * Phone normalisation happens in the SERVICE, not here — this layer just
 * accepts the mobile string it's given and queries with candidate formats.
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader, PoolConnection } from 'mysql2/promise';
import { pool } from '../../shared/db/pool.js';
import { withTransaction } from '../../shared/db/transaction.js';
import type { ResolvedUser, AuthSessionRow, UserProfileDto, DeviceMeta } from './types.js';
import type { UserRole, SubRole } from '../../shared/rbac/roles.js';

/* ==============================================================================
 * MOBILE REGISTRY
 * ============================================================================== */

export type MobileFlags = {
  mobile: string;
  whatsapp_deliverable: 'unknown' | 'yes' | 'no';
  verify_failure_count: number;
  verify_locked_until: Date | null;
  captcha_required_until: Date | null;
  admin_blocked: 0 | 1;
  admin_blocked_reason: string | null;
};

export async function getMobileFlags(mobile: string): Promise<MobileFlags | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT mobile, whatsapp_deliverable, verify_failure_count,
            verify_locked_until, captcha_required_until,
            admin_blocked, admin_blocked_reason
       FROM mobile_registry
      WHERE mobile = ?`,
    [mobile],
  );
  return rows.length ? (rows[0] as unknown as MobileFlags) : null;
}

export async function touchMobileRegistry(mobile: string): Promise<void> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile) VALUES (?)
     ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP`,
    [mobile],
  );
}

export async function markWhatsappUndeliverable(mobile: string, code: string): Promise<void> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile, whatsapp_deliverable, whatsapp_last_failure_at, whatsapp_last_failure_code)
         VALUES (?, 'no', NOW(), ?)
     ON DUPLICATE KEY UPDATE
       whatsapp_deliverable       = 'no',
       whatsapp_last_failure_at   = NOW(),
       whatsapp_last_failure_code = VALUES(whatsapp_last_failure_code)`,
    [mobile, code],
  );
}

export async function incrementVerifyFailure(mobile: string): Promise<number> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile, verify_failure_count) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE verify_failure_count = verify_failure_count + 1`,
    [mobile],
  );
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT verify_failure_count FROM mobile_registry WHERE mobile = ?`,
    [mobile],
  );
  return rows.length ? Number(rows[0]!['verify_failure_count']) : 0;
}

export async function lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void> {
  await pool.execute(
    `INSERT INTO mobile_registry (mobile, verify_locked_until, captcha_required_until)
         VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verify_locked_until    = VALUES(verify_locked_until),
       captcha_required_until = VALUES(captcha_required_until)`,
    [mobile, until, captchaUntil],
  );
}

export async function resetVerifyFailure(mobile: string): Promise<void> {
  await pool.execute(
    `UPDATE mobile_registry
        SET verify_failure_count = 0,
            verify_locked_until  = NULL
      WHERE mobile = ?`,
    [mobile],
  );
}

/* ==============================================================================
 * USER RESOLUTION — one query set per role
 * ============================================================================== */

/**
 * The four DB phone columns can be stored in any of three formats we've seen
 * in the wild:
 *   '9812345678'      — bare 10 digits
 *   '919812345678'    — E.164 without '+'
 *   '+919812345678'   — E.164 with '+'
 * We query all three shapes at once via IN(). Cheap — at most 3 index seeks.
 */
function candidateFormats(mobile: string): string[] {
  // mobile arrives as '919812345678'
  const withoutCc = mobile.replace(/^91/, '');
  return [mobile, `+${mobile}`, withoutCc];
}

/* -----------------------------------------------------------------
 * Customer
 * ----------------------------------------------------------------- */

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
 * (No `status` column in this table — customers are always treated as active.)
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

/* -----------------------------------------------------------------
 * Vendor — sub-role derived from which phone column matched
 * ----------------------------------------------------------------- */

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

/* -----------------------------------------------------------------
 * Driver
 * ----------------------------------------------------------------- */

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

/* -----------------------------------------------------------------
 * UC staff
 * ----------------------------------------------------------------- */

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

/* ==============================================================================
 * AUTH SESSIONS
 * ============================================================================== */

export type CreateSessionInput = {
  jti: string;
  role: UserRole;
  entityId: string;
  subRole: SubRole;
  refreshTokenHash: string;
  previousJti: string | null;
  device: DeviceMeta;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
};

export async function createSession(
  input: CreateSessionInput,
  conn?: PoolConnection,
): Promise<void> {
  const runner = conn ?? pool;
  await runner.execute(
    `INSERT INTO auth_sessions
       (jti, role, entity_id, sub_role, refresh_token_hash, previous_jti,
        device_id, device_name, platform, app_version, ip, user_agent,
        issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, NOW(), ?)`,
    [
      input.jti,
      input.role,
      input.entityId,
      input.subRole,
      input.refreshTokenHash,
      input.previousJti,
      input.device.id,
      input.device.name,
      input.device.platform,
      input.device.appVersion,
      input.ip,
      input.userAgent,
      input.expiresAt,
    ],
  );
}

export async function findSessionByJti(jti: string): Promise<AuthSessionRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, jti, role, entity_id, sub_role, refresh_token_hash, previous_jti,
            device_id, device_name, platform, app_version, ip, user_agent,
            issued_at, last_used_at, expires_at, revoked_at, revoked_reason
       FROM auth_sessions WHERE jti = ? LIMIT 1`,
    [jti],
  );
  return rows.length ? (rows[0] as unknown as AuthSessionRow) : null;
}

export async function markSessionRevoked(jti: string, reason: string): Promise<void> {
  await pool.execute(
    `UPDATE auth_sessions
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE jti = ? AND revoked_at IS NULL`,
    [reason, jti],
  );
}

export async function revokeAllForEntity(
  role: UserRole,
  entityId: string,
  reason: string,
): Promise<string[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT jti FROM auth_sessions
      WHERE role = ? AND entity_id = ? AND revoked_at IS NULL`,
    [role, entityId],
  );
  await pool.execute(
    `UPDATE auth_sessions
        SET revoked_at = NOW(), revoked_reason = ?
      WHERE role = ? AND entity_id = ? AND revoked_at IS NULL`,
    [reason, role, entityId],
  );
  return rows.map(r => String(r['jti']));
}

/**
 * Rotation is one transaction:
 *   1. mark oldJti revoked (rotation)
 *   2. insert new session with previous_jti = oldJti
 * Both must succeed together — otherwise we risk two active sessions or none.
 */
export async function rotateSession(oldJti: string, next: CreateSessionInput): Promise<void> {
  await withTransaction(async conn => {
    await conn.execute(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = 'rotation'
        WHERE jti = ? AND revoked_at IS NULL`,
      [oldJti],
    );
    await createSession(next, conn);
  });
}

/* ==============================================================================
 * AUDIT — otp_events + login_events
 * ============================================================================== */

export type OtpEventInsert = {
  mobile: string;
  roleRequested: UserRole;
  purpose: 'login' | 'change_mobile' | 'reverify';
  eventType:
    | 'send_requested'
    | 'send_succeeded'
    | 'send_failed'
    | 'verify_succeeded'
    | 'verify_failed'
    | 'rate_limited'
    | 'account_not_provisioned';
  channel: 'whatsapp' | 'sms' | 'voice' | 'test';
  provider?: string;
  msg91RequestId?: string | null;
  msg91ErrorCode?: string | null;
  msg91ErrorMessage?: string | null;
  fallbackFromChannel?: 'whatsapp' | 'sms' | 'voice' | null;
  idempotencyKey?: string | null;
  attemptNumber?: number;
  ip?: string | null;
  deviceId?: string | null;
  isTest?: boolean;
  accessTokenHash?: string | null;
  deliveryStatus?:
    'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'user_blocked' | 'undeliverable';
};

export async function insertOtpEvent(e: OtpEventInsert): Promise<void> {
  await pool.execute(
    `INSERT INTO otp_events
       (mobile, role_requested, purpose, event_type, channel, provider,
        idempotency_key, attempt_number, fallback_from_channel,
        msg91_request_id, msg91_error_code, msg91_error_message,
        access_token_hash, ip, device_id, is_test, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?)`,
    [
      e.mobile,
      e.roleRequested,
      e.purpose,
      e.eventType,
      e.channel,
      e.provider ?? 'msg91',
      e.idempotencyKey ?? null,
      e.attemptNumber ?? 1,
      e.fallbackFromChannel ?? null,
      e.msg91RequestId ?? null,
      e.msg91ErrorCode ?? null,
      e.msg91ErrorMessage ?? null,
      e.accessTokenHash ?? null,
      e.ip ?? null,
      e.deviceId ?? null,
      e.isTest ? 1 : 0,
      e.deliveryStatus ?? 'pending',
    ],
  );
}

export type LoginEventInsert = {
  role: UserRole;
  entityId: string | null;
  mobile: string;
  outcome:
    | 'success'
    | 'account_suspended'
    | 'account_not_provisioned'
    | 'account_not_found'
    | 'otp_invalid'
    | 'system_error';
  sessionId?: number | null;
  ip?: string | null;
  device?: DeviceMeta | null;
  userAgent?: string | null;
};

export async function insertLoginEvent(e: LoginEventInsert): Promise<void> {
  await pool.execute(
    `INSERT INTO login_events
       (role, entity_id, mobile, outcome, session_id,
        ip, device_id, device_name, platform, app_version, user_agent)
     VALUES (?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?, ?, ?)`,
    [
      e.role,
      e.entityId,
      e.mobile,
      e.outcome,
      e.sessionId ?? null,
      e.ip ?? null,
      e.device?.id ?? null,
      e.device?.name ?? null,
      e.device?.platform ?? null,
      e.device?.appVersion ?? null,
      e.userAgent ?? null,
    ],
  );
}
