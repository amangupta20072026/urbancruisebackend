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
  /**
   * Upstream OTP provider is temporarily unable to deliver messages.
   * Surfaced with HTTP 503. Causes include:
   *   - MSG91 wallet balance exhausted (top up)
   *   - MSG91 circuit breaker open (provider had repeated recent failures)
   *
   * Mobile client shows a "try again shortly" screen. This is distinct from
   * `OTP_SEND_FAILED` (config bug on our side) and `SIGNUPS_DISABLED` (a
   * business decision) — the code lets ops-side alerting distinguish them.
   */
  SERVICE_UNAVAILABLE: 'service_unavailable',
  SESSION_REVOKED: 'session_revoked',
  /**
   * Emitted by /auth/me when the underlying entity (customer/driver/…) row
   * has been deleted while the session was live. We also revoke the session
   * so the client can't keep hitting other endpoints with a dead identity.
   */
  SESSION_ORPHANED: 'session_orphaned',
  REFRESH_INVALID: 'refresh_invalid',
  /** New-customer onboarding ticket missing, expired or already used —
   *  the client must restart from phone entry (request a new OTP). */
  ONBOARDING_EXPIRED: 'onboarding_expired',
  /** Onboarding ticket presented from a different device than the one
   *  that verified the OTP. */
  ONBOARDING_INVALID: 'onboarding_invalid',
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
  /**
   * Delivery channel of the OTP that produced this session.
   * SMS is the only supported channel today. When email OTP lands, widen
   * to `'sms' | 'email'` — the value is recorded so verify audit / login
   * events can attribute the channel used.
   */
  channel: 'sms';
  isTest: boolean;
  attempts: number;
  sentAt: number;
  /**
   * IP block (IPv4 /24 or IPv6 /64 key) charged when this OTP was SENT.
   * A successful verify is credited to THIS block, not the verify request's
   * IP — mobile devices often change IP between send and verify. null for
   * test mobiles / unknown IP. Optional: sessions written before the M4
   * deploy don't have it (they simply aren't credited).
   */
  ipBlock?: string | null;
};

/* ==============================================================================
 * Resolved user (what phone-lookup returns before mint)
 * ============================================================================== */

export type ResolvedUser = {
  role: UserRole;
  entityId: string;
  userId: string;
  subRole: SubRole;
  /**
   * 'active'   — may log in.
   * 'inactive' — exists but must NOT log in (suspended, left, blocked, or any
   *              status value not on the allowlist in config/constants.ts).
   */
  status: 'active' | 'inactive';
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

/** Session payload returned whenever a login completes (verify for an
 *  existing user, or onboarding for a new customer). */
export type AuthenticatedResponseDto = {
  status: 'authenticated';
  accessToken: string;
  refreshToken: string;
  userId: string;
  role: UserRole;
  subRole: SubRole;
  entityId: string;
  requiresProfileSetup: boolean;
  profile: UserProfileDto;
};

/** Returned by verify when the OTP is correct but the number is a NEW
 *  customer. No session exists yet and no customer row has been created:
 *  the client shows the onboarding form and calls
 *  POST /auth/customer/onboard with this token. */
export type OnboardingRequiredResponseDto = {
  status: 'onboarding_required';
  onboardingToken: string;
  expiresInSeconds: number;
  role: 'customer';
};

export type VerifyOtpResponseDto = AuthenticatedResponseDto | OnboardingRequiredResponseDto;

/** Redis-stored onboarding ticket (value of `auth:onboard:{sha256(token)}`). */
export type OnboardingTicket = {
  mobile: string;
  deviceId: string;
  issuedAt: number;
};

/** Minimum customer details collected by the onboarding screen. */
export type CustomerOnboardingDetails = {
  firstName: string;
  lastName: string | null;
  email: string | null;
};

/**
 * Response for POST /auth/otp/request.
 *
 * `channel` is deliberately kept in the shape (rather than removed) so the
 * shipped mobile app — which reads it — continues to parse the payload
 * unchanged. When email OTP lands, widen the union to `'sms' | 'email'`
 * and set it from the resolved dispatch channel. Do not drop the field.
 */
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

/**
 * GET /auth/me — server-authoritative identity for the currently attached
 * session. Same fields as verify's response minus the token pair (the
 * caller already has them). Used by mobile bootstrap to confirm the
 * cached session is still trusted before landing the user on Home.
 */
export type MeResponseDto = {
  userId: string;
  role: UserRole;
  subRole: SubRole;
  entityId: string;
  requiresProfileSetup: boolean;
  profile: UserProfileDto;
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

/**
 * Device as STORED on an auth_sessions row. Every column is nullable: a
 * refresh that carries no device inherits the previous session's values,
 * and those may be empty (rows written before fix H1 held the fake
 * 'unknown-device', which is now stored as null instead). A DeviceMeta is
 * always a valid SessionDevice.
 */
export type SessionDevice = {
  id: string | null;
  name: string | null;
  platform: 'ios' | 'android' | null;
  appVersion: string | null;
};
