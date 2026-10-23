/**
 * auth types. Row types mirror DB column names exactly (customers is
 * camelCase, other tables snake_case).
 * AUTH_ERROR is the source of truth for error codes the app switches on:
 * add codes here first, then handle them in the app.
 */
import type { UserRole } from '../../shared/rbac/roles.js';

/* Error codes returned to the app (ApiError.code) */

export const AUTH_ERROR = {
  ACCOUNT_NOT_PROVISIONED: 'account_not_provisioned',
  ACCOUNT_SUSPENDED: 'account_suspended',
  ACCOUNT_LOCKED: 'account_locked',
  CAPTCHA_REQUIRED: 'captcha_required',
  MOBILE_BLOCKED: 'mobile_blocked',
  OTP_SEND_FAILED: 'otp_send_failed',
  OTP_INVALID: 'otp_invalid',
  OTP_EXPIRED: 'otp_expired',
  /**
   * 503: MSG91 can't deliver right now (wallet empty or circuit open).
   * Distinct from OTP_SEND_FAILED, which is a config error on our side.
   */
  SERVICE_UNAVAILABLE: 'service_unavailable',
  SESSION_REVOKED: 'session_revoked',
  /** /auth/me found the account row deleted; the session is revoked too. */
  SESSION_ORPHANED: 'session_orphaned',
  REFRESH_INVALID: 'refresh_invalid',
  /** Onboarding ticket missing, expired or used: restart from phone entry. */
  ONBOARDING_EXPIRED: 'onboarding_expired',
  /** Onboarding ticket used from a different device than the one that verified. */
  ONBOARDING_INVALID: 'onboarding_invalid',
} as const;

/* OTP session (Redis) */

export type OtpSession = {
  requestId: string;
  mobile: string;
  otpHash: string;
  role: UserRole;
  /** Delivery channel; only SMS today. */
  channel: 'sms';
  isTest: boolean;
  attempts: number;
  sentAt: number;
  /**
   * IP block (IPv4 /24, IPv6 /64) charged at send time. A successful verify
   * is credited here, since phones often change IP in between. null for test
   * mobiles or unknown IP; absent on older sessions.
   */
  ipBlock?: string | null;
};

/* Account found by phone lookup */

export type ResolvedUser = {
  role: UserRole;
  entityId: string;
  userId: string;
  /** 'inactive' covers any status not in ACTIVE_STATUS_VALUES; such accounts can't log in. */
  status: 'active' | 'inactive';
  requiresProfileSetup: boolean;
};

/* auth_sessions row */

export type AuthSessionRow = {
  id: number;
  jti: string;
  role: UserRole;
  entity_id: string;
  refresh_token_hash: string;
  previous_jti: string | null;
  /** NULL only on rows written before the family_id migration. */
  family_id: string | null;
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

/* Response DTOs */

export type UserProfileDto = {
  id: string;
  displayName: string;
  email: string | null;
  phoneIndia: string;
  phoneGlobal: string;
  memberSince: string;
};

/** Returned when a login completes (verify or onboarding). */
export type AuthenticatedResponseDto = {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: UserRole;
  entityId: string;
  requiresProfileSetup: boolean;
  profile: UserProfileDto;
};

/**
 * Verify result for a new customer. No account or session exists yet; the
 * app calls POST /auth/customer/onboard with this token.
 */
export type OnboardingRequiredResponseDto = {
  status: 'onboarding_required';
  onboardingToken: string;
  expiresInSeconds: number;
  role: 'customer';
};

export type VerifyOtpResponseDto = AuthenticatedResponseDto | OnboardingRequiredResponseDto;

/**
 * POST /auth/customer/onboard response. isNewAccount is false when a
 * customer already existed for this mobile (the request logged into that
 * account instead), so the app shows its first-time welcome only when true.
 */
export type CustomerOnboardResponseDto = AuthenticatedResponseDto & {
  isNewAccount: boolean;
};

/** Onboarding ticket stored in Redis under the token's hash. */
export type OnboardingTicket = {
  mobile: string;
  deviceId: string;
  issuedAt: number;
};

/**
 * Customer kind chosen at onboarding (API value). Same values as the
 * CustomerCategory type in shared/rbac/roles.ts. The repository maps it to
 * the CRM's customers.customerType text; never write it to the DB as is.
 */
export type CustomerSignupType = 'personal' | 'corporate' | 'agent';

/** Details collected at onboarding. */
export type CustomerOnboardingDetails = {
  firstName: string;
  lastName: string | null;
  email: string | null;
  customerType: CustomerSignupType;
  /** Trimmed city name, saved as entered or as returned by the device. */
  city: string;
};

/** POST /auth/otp/request response. Keep `channel`: shipped apps read it. */
export type RequestOtpResponseDto = {
  requestId: string;
  resendAfterSeconds: number;
  channel: 'sms';
  testMode: boolean;
};

export type RefreshResponseDto = {
  accessToken: string;
  refreshToken: string;
};

/** GET /auth/me: the verify response without tokens. The app checks it at startup. */
export type MeResponseDto = {
  userId: string;
  role: UserRole;
  entityId: string;
  requiresProfileSetup: boolean;
  profile: UserProfileDto;
};

/* Device sent by the app */

export type DeviceMeta = {
  id: string;
  name: string;
  platform: 'ios' | 'android';
  appVersion: string;
};

/** Device as stored on auth_sessions. All nullable: an inherited device may be unknown. */
export type SessionDevice = {
  id: string | null;
  name: string | null;
  platform: 'ios' | 'android' | null;
  appVersion: string | null;
};
