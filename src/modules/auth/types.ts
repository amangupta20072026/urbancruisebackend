/**
 * ==============================================================================
 * auth — types (DB rows + DTOs + error codes)
 * ==============================================================================
 * Row shapes here map EXACTLY to the DB — snake_case where the column is
 * snake_case, camelCase where it is (customers table is camelCase). Don't
 * "normalize" — the repository maps DB → domain and the domain flows out
 * as DTOs (below).
 *
 * The AuthErrorCode enum is the SINGLE SOURCE for the `code` field the RN
 * app switches on (see ApiError.code on the client). Add codes here first,
 * then handle them in the client.
 * ==============================================================================
 */
import type { UserRole, SubRole } from '../../shared/rbac/roles.js';

/* ==============================================================================
 * Error codes surfaced to the client (in ApiError.code)
 * ============================================================================== */

export const AUTH_ERROR = {
  ACCOUNT_NOT_PROVISIONED: 'account_not_provisioned',
  ACCOUNT_SUSPENDED: 'account_suspended',
  ACCOUNT_LOCKED: 'account_locked',
  SIGNUPS_DISABLED: 'signups_disabled',
  CAPTCHA_REQUIRED: 'captcha_required',
  MOBILE_BLOCKED: 'mobile_blocked',
  OTP_SEND_FAILED: 'otp_send_failed',
  OTP_INVALID: 'otp_invalid',
  OTP_EXPIRED: 'otp_expired',
  SESSION_REVOKED: 'session_revoked',
  REFRESH_INVALID: 'refresh_invalid',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];

/* ==============================================================================
 * Redis-stored OTP session (JSON in `otp:session:{requestId}`)
 * ============================================================================== */

export type OtpSession = {
  requestId: string;
  mobile: string;
  otpHash: string;
  role: UserRole;
  channel: 'whatsapp' | 'sms';
  isTest: boolean;
  attempts: number;
  sentAt: number;
};

/* ==============================================================================
 * Resolved user (what phone-lookup returns before mint)
 * ============================================================================== */

export type ResolvedUser = {
  role: UserRole;
  entityId: string;
  userId: string;
  subRole: SubRole;
  status: 'active' | 'suspended' | 'deleted' | 'other';
  requiresProfileSetup: boolean;
};

/* ==============================================================================
 * Session DB row (auth_sessions)
 * ============================================================================== */

export type AuthSessionRow = {
  id: number;
  jti: string;
  role: UserRole;
  entity_id: string;
  sub_role: string | null;
  refresh_token_hash: string;
  previous_jti: string | null;
  device_id: string | null;
  device_name: string | null;
  platform: 'ios' | 'android' | null;
  app_version: string | null;
  ip: Buffer | null;
  user_agent: string | null;
  issued_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
};

/* ==============================================================================
 * Wire DTOs
 * ============================================================================== */

export type UserProfileDto = {
  id: string;
  displayName: string;
  email: string | null;
  phoneIndia: string;
  phoneGlobal: string;
  memberSince: string;
};

export type VerifyOtpResponseDto = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: UserRole;
  subRole: SubRole;
  entityId: string;
  requiresProfileSetup: boolean;
  profile: UserProfileDto;
};

export type RequestOtpResponseDto = {
  requestId: string;
  resendAfterSeconds: number;
  channel: 'whatsapp' | 'sms';
  testMode: boolean;
};

export type RefreshResponseDto = {
  accessToken: string;
  refreshToken: string;
};

/* ==============================================================================
 * Device metadata sent by client on verify (auth_sessions.device_*)
 * ============================================================================== */

export type DeviceMeta = {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  appVersion: string;
};
