/**
 * Port for all auth persistence (MySQL). Implementation: MysqlAuthRepository,
 * wired in AuthContainer.
 */

import type { MobileFlags } from '../repository/mobile-registry.js';
import type {
  ResolvedUser,
  UserProfileDto,
  AuthSessionRow,
  CustomerOnboardingDetails,
} from '../types.js';
import type { CreateSessionInput, RevokeReason } from '../repository/sessions.js';
import type { OtpEventInsert, LoginEventInsert, DlrUpdate } from '../repository/audit.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

// Re-exported so callers don't import from the repository folder.
export type { OtpEventInsert, LoginEventInsert, DlrUpdate, RevokeReason };

export interface IAuthRepository {
  // mobile_registry

  getMobileFlags(mobile: string): Promise<MobileFlags | null>;
  touchMobileRegistry(mobile: string): Promise<void>;
  incrementVerifyFailure(mobile: string): Promise<number>;
  lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void>;
  resetVerifyFailure(mobile: string): Promise<void>;

  // users

  findUserByPhone(role: UserRole, mobile: string): Promise<ResolvedUser | null>;

  /**
   * Creates the customer at onboarding. If one exists (even concurrently),
   * returns it with created=false.
   */
  createCustomerIfAbsent(
    mobile: string,
    details: CustomerOnboardingDetails,
  ): Promise<{ user: ResolvedUser; created: boolean }>;

  /** Account status; null if the row no longer exists. */
  getAccountStatus(role: UserRole, entityId: string): Promise<ResolvedUser['status'] | null>;

  // profiles

  loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto>;
  loadIdentityDetails(
    role: UserRole,
    entityId: string,
  ): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null>;

  // sessions

  createSession(input: CreateSessionInput): Promise<void>;
  findSessionByJti(jti: string): Promise<AuthSessionRow | null>;
  markSessionRevoked(jti: string, reason: RevokeReason): Promise<void>;
  revokeAllForEntity(role: UserRole, entityId: string, reason: RevokeReason): Promise<string[]>;
  /** Atomically revokes oldJti and creates next. False if oldJti was already revoked. */
  rotateSession(oldJti: string, next: CreateSessionInput): Promise<boolean>;
  /**
   * True if oldJti was rotated within graceSeconds (DB clock) and its
   * replacement is still active: a duplicate refresh, not token theft.
   */
  isWithinRotationGrace(oldJti: string, graceSeconds: number): Promise<boolean>;

  // push tokens

  /** Deletes an account's push tokens on sign-out. deviceId null means all devices. */
  deletePushTokens(role: UserRole, entityId: string, deviceId: string | null): Promise<void>;

  // audit

  insertOtpEvent(e: OtpEventInsert): Promise<void>;
  insertLoginEvent(e: LoginEventInsert): Promise<void>;

  /** Applies an MSG91 DLR to its pending otp_events row. Idempotent; returns rows updated. */
  applyDlr(update: DlrUpdate): Promise<number>;
}
