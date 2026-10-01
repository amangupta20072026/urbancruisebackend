/**
 * ==============================================================================
 * auth.repository — shared helpers for user repository files
 * ==============================================================================
 * These utilities are used by every per-role repository file.
 * Kept in one place so the logic is not duplicated across four files.
 *
 * CONTENTS
 *   candidateFormats   — produces the three phone-format variants we query
 *   joinName           — concatenates first + last name, filtering nulls
 *   normalisePhoneToE164 — converts any stored phone shape to '+91...' display
 *   placeholder        — fallback UserProfileDto when a row has vanished
 *   normStatus         — maps raw DB status strings to ResolvedUser['status']
 * ==============================================================================
 */

import type { UserProfileDto } from '../types.js';
import type { ResolvedUser } from '../types.js';

/* --------------------------------------------------------------------------
 * Candidate phone formats
 * --------------------------------------------------------------------------
 * The four DB phone columns can be stored in any of three formats we've
 * seen in the wild:
 *   '9812345678'     — bare 10 digits
 *   '919812345678'   — E.164 without '+'
 *   '+919812345678'  — E.164 with '+'
 * We query all three shapes at once via IN(). Cheap — at most 3 index seeks.
 * -------------------------------------------------------------------------- */
export function candidateFormats(mobile: string): string[] {
  const withoutCc = mobile.replace(/^91/, '');
  return [mobile, `+${mobile}`, withoutCc];
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
export function normStatus(s: string | null): ResolvedUser['status'] {
  if (s === 'active' || s === 'suspended' || s === 'deleted') return s;
  return s === null ? 'active' : 'other';
}
