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
  /** hCaptcha token. Required only after a 400 `captcha_required` (the number
   *  is inside its post-lockout CAPTCHA window and HCAPTCHA_SECRET is set). */
  captchaToken: z.string().min(1).max(4096).optional(),
});
export type RequestOtpBody = z.infer<typeof RequestOtpBody>;

/* -----------------------------------------------------------------
 * POST /auth/otp/verify
 * ----------------------------------------------------------------- */

const DeviceMetaSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(150),
  platform: z.enum(['ios', 'android']),
  appVersion: z.string().min(1).max(30),
});

export const VerifyOtpBody = z.object({
  phone: IndianPhoneSchema,
  countryCode: CountryCodeSchema,
  role: RoleSchema,
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
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

/* -----------------------------------------------------------------
 * POST /auth/customer/onboard — minimum details for a NEW customer.
 * Lengths match the `customers` columns (firstName/lastName varchar(50),
 * customerEmail varchar(100)).
 * ----------------------------------------------------------------- */
const NAME_RE = /^[\p{L}][\p{L}\p{M} .'-]*$/u;

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform(v => (v ? v : null));

export const CustomerOnboardBody = z.object({
  onboardingToken: z.string().min(20).max(200),
  firstName: z
    .string()
    .trim()
    .min(1, 'first name is required')
    .max(50)
    .regex(NAME_RE, 'first name contains invalid characters'),
  lastName: optionalTrimmed(50).refine(v => v === null || NAME_RE.test(v), {
    message: 'last name contains invalid characters',
  }),
  email: optionalTrimmed(100).refine(v => v === null || z.email().safeParse(v).success, {
    message: 'invalid email address',
  }),
  device: DeviceMetaSchema,
});
export type CustomerOnboardBody = z.infer<typeof CustomerOnboardBody>;
