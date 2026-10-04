/**
 * ==============================================================================
 * MysqlAuthRepository — production IAuthRepository backed by mysql2
 * ==============================================================================
 * Delegates every method to the existing repository functions. This class is
 * purely a thin adapter — zero business logic, zero new SQL. Existing
 * repository files (users.ts, sessions.ts, audit.ts, mobile-registry.ts)
 * stay unchanged; this class is the bridge that lets the service layer depend
 * on an interface instead of on the concrete module exports.
 *
 * When the repository files are eventually split per-table (per the SRP audit
 * recommendation), only this file changes — the service files and their tests
 * are untouched.
 * ==============================================================================
 */

import type { IAuthRepository } from '../ports/IAuthRepository.js';
import type { MobileFlags } from '../repository/mobile-registry.js';
import type {
  ResolvedUser,
  UserProfileDto,
  AuthSessionRow,
  CustomerOnboardingDetails,
} from '../types.js';
import type { OtpEventInsert, LoginEventInsert, DlrUpdate } from '../repository/audit.js';
import type { CreateSessionInput, RevokeReason } from '../repository/sessions.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

// Existing repository functions — imported individually so the adapter stays
// explicit about every dependency it bridges.
import {
  getMobileFlags,
  touchMobileRegistry,
  incrementVerifyFailure,
  lockMobile,
  resetVerifyFailure,
} from '../repository/mobile-registry.js';

import {
  findUserByPhone,
  createCustomerIfAbsent,
  getAccountStatus,
  loadProfile,
  loadIdentityDetails,
} from '../repository/users.js';

import {
  createSession,
  findSessionByJti,
  markSessionRevoked,
  revokeAllForEntity,
  rotateSession,
} from '../repository/sessions.js';

import { insertOtpEvent, insertLoginEvent, applyDlr } from '../repository/audit.js';

export class MysqlAuthRepository implements IAuthRepository {
  // ── mobile_registry ─────────────────────────────────────────────────────

  getMobileFlags(mobile: string): Promise<MobileFlags | null> {
    return getMobileFlags(mobile);
  }

  touchMobileRegistry(mobile: string): Promise<void> {
    return touchMobileRegistry(mobile);
  }

  incrementVerifyFailure(mobile: string): Promise<number> {
    return incrementVerifyFailure(mobile);
  }

  lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void> {
    return lockMobile(mobile, until, captchaUntil);
  }

  resetVerifyFailure(mobile: string): Promise<void> {
    return resetVerifyFailure(mobile);
  }

  // ── users ────────────────────────────────────────────────────────────────

  findUserByPhone(role: UserRole, mobile: string): Promise<ResolvedUser | null> {
    return findUserByPhone(role, mobile);
  }

  createCustomerIfAbsent(
    mobile: string,
    details: CustomerOnboardingDetails,
  ): Promise<{ user: ResolvedUser; created: boolean }> {
    return createCustomerIfAbsent(mobile, details);
  }

  getAccountStatus(role: UserRole, entityId: string): Promise<ResolvedUser['status'] | null> {
    return getAccountStatus(role, entityId);
  }

  // ── profiles ─────────────────────────────────────────────────────────────

  loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto> {
    return loadProfile(role, entityId);
  }

  loadIdentityDetails(
    role: UserRole,
    entityId: string,
  ): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
    return loadIdentityDetails(role, entityId);
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  createSession(input: CreateSessionInput): Promise<void> {
    return createSession(input);
  }

  findSessionByJti(jti: string): Promise<AuthSessionRow | null> {
    return findSessionByJti(jti);
  }

  markSessionRevoked(jti: string, reason: RevokeReason): Promise<void> {
    return markSessionRevoked(jti, reason);
  }

  revokeAllForEntity(role: UserRole, entityId: string, reason: RevokeReason): Promise<string[]> {
    return revokeAllForEntity(role, entityId, reason);
  }

  rotateSession(oldJti: string, next: CreateSessionInput): Promise<boolean> {
    return rotateSession(oldJti, next);
  }

  // ── audit ────────────────────────────────────────────────────────────────

  insertOtpEvent(e: OtpEventInsert): Promise<void> {
    return insertOtpEvent(e);
  }

  insertLoginEvent(e: LoginEventInsert): Promise<void> {
    return insertLoginEvent(e);
  }

  applyDlr(update: DlrUpdate): Promise<number> {
    return applyDlr(update);
  }
}
