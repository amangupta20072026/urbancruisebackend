/**
 * ==============================================================================
 * auth.repository — shared helpers for user repository files
 * ==============================================================================
 * These utilities are used by every per-role repository file.
 * Kept in one place so the logic is not duplicated across four files.
 *
 * CONTENTS
 *   toDbPhone          — the ONE production format for writes ('+91 XXXXXXXXXX')
 *   candidateFormats   — production format + legacy shapes for lookups
 *   placeholders       — builds the IN (?, ...) list for candidateFormats
 *   joinName           — concatenates first + last name, filtering nulls
 *   normalisePhoneToE164 — converts any stored phone shape to '+91...' display
 *   placeholder        — fallback UserProfileDto when a row has vanished
 *   normStatus         — allowlist: raw DB status → 'active' | 'inactive'
 * ==============================================================================
 */

import type { UserProfileDto } from '../types.js';
import type { ResolvedUser } from '../types.js';
import { ACTIVE_STATUS_VALUES } from '../../../config/constants.js';

/* --------------------------------------------------------------------------
 * Production phone format
 * --------------------------------------------------------------------------
 * The centralized DB (shared with the web app) stores every login phone as
 *   '+91 9812345678'   — country code, ONE space, 10 digits
 * Every write from this backend MUST go through toDbPhone().
 *
 * Input is the internal mobile from normalizeMobile(): '919812345678'.
 * -------------------------------------------------------------------------- */
export function toDbPhone(mobile: string): string {
  const last10 = mobile.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(last10)) {
    throw new Error('toDbPhone: not a valid Indian mobile number');
  }
  return `+91 ${last10}`;
}

/* --------------------------------------------------------------------------
 * Candidate phone formats (lookup)
 * --------------------------------------------------------------------------
 * Production format first; legacy shapes kept as a safety net in case the
 * web app or a manual edit writes a non-standard value. Exact IN() match,
 * so the column index is still used.
 * -------------------------------------------------------------------------- */
export function candidateFormats(mobile: string): string[] {
  const last10 = mobile.replace(/\D/g, '').slice(-10);
  return [`+91 ${last10}`, `91${last10}`, `+91${last10}`, last10];
}

/** `?, ?, ?, ?` — one placeholder per candidate format. */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/* --------------------------------------------------------------------------
 * Name helpers
 * -------------------------------------------------------------------------- */
export function joinName(a: string | null, b: string | null): string {
  return [a, b].filter(Boolean).join(' ').trim();
}

/* --------------------------------------------------------------------------
 * Phone display normalisation
 * --------------------------------------------------------------------------
 * DB-projection helper — converts any of the three storage shapes we
 * accept into the '+91...' display string used in the profile DTO.
 * The service-layer `normalizeMobile` in shared/utils/phone.ts produces
 * the internal (no-plus) shape used for keying. Different jobs with
 * unfortunately similar names; kept here so they don't get mixed.
 * -------------------------------------------------------------------------- */
export function normalisePhoneToE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}

/* --------------------------------------------------------------------------
 * Placeholder profile — returned by loadProfile when the row is missing
 * (safe for the login response — /me uses null as a first-class signal)
 * -------------------------------------------------------------------------- */
export function placeholder(id: string): UserProfileDto {
  return {
    id,
    displayName: 'User',
    email: null,
    phoneIndia: '',
    phoneGlobal: '',
    memberSince: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------------------
 * Status normalisation
 * -------------------------------------------------------------------------- */
export function normStatus(
  raw: string | null,
  opts: { nullIsActive: boolean },
): ResolvedUser['status'] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return opts.nullIsActive ? 'active' : 'inactive';
  return ACTIVE_STATUS_VALUES.has(v) ? 'active' : 'inactive';
}
