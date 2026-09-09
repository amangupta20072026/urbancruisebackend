/**
 * ==============================================================================
 * auth — Zod schemas (validated req.body shapes)
 * ==============================================================================
 * Client sends phone SPLIT into `phone` (10 digits) + `countryCode` ('+91').
 * Server normalises to E.164-without-plus ('919812345678') downstream — see
 * `normalizeMobile()` in the service.
 * ==============================================================================
 */
import { z } from 'zod';

/** All roles the auth module knows how to resolve. */
const RoleSchema = z.enum(['customer', 'vendor', 'driver', 'uc']);

/** India-only for MVP. Client already enforces this; server double-checks. */
const IndianPhoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'invalid Indian mobile number');
const CountryCodeSchema = z.literal('+91');

/* -----------------------------------------------------------------
 * POST /auth/otp/request
 * ----------------------------------------------------------------- */

export const RequestOtpBody = z.object({
  phone: IndianPhoneSchema,
  countryCode: CountryCodeSchema,
  role: RoleSchema,
  /** hCaptcha / reCAPTCHA token when required by a previous 400. Optional. */
  captchaToken: z.string().min(1).max(4096).optional(),
});
export type RequestOtpBody = z.infer<typeof RequestOtpBody>;

/* -----------------------------------------------------------------
 * POST /auth/otp/verify
 * ----------------------------------------------------------------- */

const DeviceMetaSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(150),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().min(1).max(30),
});

export const VerifyOtpBody = z.object({
  phone: IndianPhoneSchema,
  countryCode: CountryCodeSchema,
  role: RoleSchema,
  otp: z.string().regex(/^\d{4,6}$/, 'OTP must be 4-6 digits'),
  requestId: z.string().min(1).max(128).optional(),
  device: DeviceMetaSchema,
});
export type VerifyOtpBody = z.infer<typeof VerifyOtpBody>;

/* -----------------------------------------------------------------
 * POST /auth/refresh
 * ----------------------------------------------------------------- */

export const RefreshBody = z.object({
  refreshToken: z.string().min(20).max(4096),
});
export type RefreshBody = z.infer<typeof RefreshBody>;

/* -----------------------------------------------------------------
 * POST /auth/logout
 * ----------------------------------------------------------------- */

export const LogoutBody = z.object({
  /** Optional — if missing, logout revokes only the current access-token session. */
  refreshToken: z.string().min(20).max(4096).optional(),
  /** 'current' (default) — revoke this session only. 'all' — revoke every
   *  session for this user across all devices. */
  scope: z.enum(['current', 'all']).default('current'),
});
export type LogoutBody = z.infer<typeof LogoutBody>;
