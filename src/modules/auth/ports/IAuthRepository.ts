/**
 * ==============================================================================
 * IAuthRepository — port for all auth-module persistence (MySQL)
 * ==============================================================================
 * Every function the auth services call against the database is declared here.
 * The service layer imports this interface; the real MySQL implementation is
 * wired at startup via the container (see infrastructure/AuthContainer.ts).
 *
 * GROUPING (mirrors the repository directory structure):
 *   1. mobile_registry  — per-mobile hard-block and brute-force lock flags
 *   2. users            — cross-role phone lookup + customer auto-provisioning
 *   3. profiles         — profile DTO loaders (for /verify response and /me)
 *   4. sessions         — auth_sessions CRUD + atomic rotation
 *   5. audit            — otp_events + login_events inserts, DLR updates
 *   6. push tokens      — cleanup of push_tokens on sign-out
 *
 * IMPLEMENTATIONS
 *   MysqlAuthRepository   — wraps the mysql2 pool (production)
 *   InMemoryAuthRepository — plain JS Maps/arrays (unit tests, no DB needed)
 * ==============================================================================
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

// Re-export the audit input types so callers can import from the port layer
// instead of reaching into the repository implementation directory.
export type { OtpEventInsert, LoginEventInsert, DlrUpdate, RevokeReason };

export interface IAuthRepository {
  // ── mobile_registry ───────────────────────────────────────────────────────

  getMobileFlags(mobile: string): Promise<MobileFlags | null>;
  touchMobileRegistry(mobile: string): Promise<void>;
  incrementVerifyFailure(mobile: string): Promise<number>;
  lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void>;
  resetVerifyFailure(mobile: string): Promise<void>;

  // ── users — phone lookup + customer provisioning ──────────────────────────

  findUserByPhone(role: UserRole, mobile: string): Promise<ResolvedUser | null>;

  /**
   * Create the customer ONLY after onboarding details are submitted.
   * Must be duplicate-safe: if a row for this mobile already exists (or
   * appears concurrently), return it with created=false instead of inserting.
   */
  createCustomerIfAbsent(
    mobile: string,
    details: CustomerOnboardingDetails,
  ): Promise<{ user: ResolvedUser; created: boolean }>;

  /** Current status of a known account; null when the row no longer exists. */
  getAccountStatus(role: UserRole, entityId: string): Promise<ResolvedUser['status'] | null>;

  // ── profiles ──────────────────────────────────────────────────────────────

  loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto>;
  loadIdentityDetails(
    role: UserRole,
    entityId: string,
  ): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null>;

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput): Promise<void>;
  findSessionByJti(jti: string): Promise<AuthSessionRow | null>;
  markSessionRevoked(jti: string, reason: RevokeReason): Promise<void>;
  revokeAllForEntity(role: UserRole, entityId: string, reason: RevokeReason): Promise<string[]>;
  /** Atomically revoke oldJti and create next. Returns false (and creates
   *  nothing) when oldJti was already revoked by a concurrent refresh. */
  rotateSession(oldJti: string, next: CreateSessionInput): Promise<boolean>;

  // ── push tokens (cleanup on sign-out) ─────────────────────────────────────

  /**
   * Delete push tokens for one account so a signed-out device stops
   * receiving its notifications. `deviceId` null = every device.
   */
  deletePushTokens(role: UserRole, entityId: string, deviceId: string | null): Promise<void>;

  // ── audit ─────────────────────────────────────────────────────────────────

  insertOtpEvent(e: OtpEventInsert): Promise<void>;
  insertLoginEvent(e: LoginEventInsert): Promise<void>;

  /**
   * Apply one MSG91 DLR to its otp_events row. Idempotent — only transitions
   * from 'pending'; returns the number of rows actually updated (0 or 1).
   */
  applyDlr(update: DlrUpdate): Promise<number>;
}
