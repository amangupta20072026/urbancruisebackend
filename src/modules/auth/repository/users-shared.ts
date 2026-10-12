/** Helpers shared by the per-role user repository files. */

import type { UserProfileDto } from '../types.js';
import type { ResolvedUser } from '../types.js';
import { ACTIVE_STATUS_VALUES } from '../../../config/constants.js';

/**
 * '919812345678' → '+91 9812345678', the format the shared DB uses.
 * Every phone write must go through this.
 */
export function toDbPhone(mobile: string): string {
  const last10 = mobile.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(last10)) {
    throw new Error('toDbPhone: not a valid Indian mobile number');
  }
  return `+91 ${last10}`;
}

/** Lookup formats, production first then legacy. Exact IN() keeps the index usable. */
export function candidateFormats(mobile: string): string[] {
  const last10 = mobile.replace(/\D/g, '').slice(-10);
  return [`+91 ${last10}`, `91${last10}`, `+91${last10}`, last10];
}

/** One `?` per candidate format. */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** Joins first and last name, skipping nulls. */
export function joinName(a: string | null, b: string | null): string {
  return [a, b].filter(Boolean).join(' ').trim();
}

/**
 * Any stored phone shape → '+91…' for display in profiles. Not the same as
 * normalizeMobile() (shared/utils/phone.ts), which builds internal keys.
 */
export function normalisePhoneToE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  return `+${digits}`;
}

/** Profile used by loadProfile when the row is missing. /me returns null instead. */
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

/** Raw status → 'active' | 'inactive' using the ACTIVE_STATUS_VALUES allowlist. */
export function normStatus(
  raw: string | null,
  opts: { nullIsActive: boolean },
): ResolvedUser['status'] {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return opts.nullIsActive ? 'active' : 'inactive';
  return ACTIVE_STATUS_VALUES.has(v) ? 'active' : 'inactive';
}
