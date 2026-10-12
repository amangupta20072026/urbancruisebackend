/**
 * auth request schemas. The app sends a 10-digit `phone` and `countryCode`
 * '+91' (India only); the service normalises to '919812345678'.
 */
import { z } from 'zod';

/** Roles that can log in. */
const RoleSchema = z.enum(['customer', 'vendor', 'driver', 'uc']);

/** India only for now. */
const IndianPhoneSchema = z.string().regex(/^[6-9]\d{9}$/, 'invalid Indian mobile number');
const CountryCodeSchema = z.literal('+91');

export const RequestOtpBody = z.object({
  phone: IndianPhoneSchema,
  countryCode: CountryCodeSchema,
  role: RoleSchema,
  /** hCaptcha token. Needed only after a `captcha_required` response. */
  captchaToken: z.string().min(1).max(4096).optional(),
});
export type RequestOtpBody = z.infer<typeof RequestOtpBody>;

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

export const RefreshBody = z.object({
  refreshToken: z.string().min(20).max(4096),
  /**
   * Optional for older app builds; when absent the previous session's device
   * is kept. Must stay declared: Zod strips unknown keys, and logout relies
   * on the session's device id to remove the right push token.
   */
  device: DeviceMetaSchema.optional(),
});
export type RefreshBody = z.infer<typeof RefreshBody>;

export const LogoutBody = z.object({
  /** Optional. Logout identifies the session from the access token. */
  refreshToken: z.string().min(20).max(4096).optional(),
  /** 'current' (default) revokes this session; 'all' revokes every device. */
  scope: z.enum(['current', 'all']).default('current'),
});
export type LogoutBody = z.infer<typeof LogoutBody>;

/** Lengths match the customers columns (names 50, email 100). */
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
