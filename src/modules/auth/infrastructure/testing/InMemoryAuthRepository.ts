/**
 * ==============================================================================
 * InMemoryAuthRepository — test double for IAuthRepository
 * ==============================================================================
 * Uses plain JS Maps and arrays. No MySQL, no network, deterministic.
 *
 * USAGE IN TESTS:
 *
 *   import { InMemoryAuthRepository } from '.../testing/InMemoryAuthRepository.js';
 *   import { buildAuthDeps } from '.../infrastructure/AuthContainer.js';
 *
 *   const repo = new InMemoryAuthRepository();
 *
 *   // seed a known customer
 *   repo.seedUser({
 *     role: 'customer', mobile: '919999999999',
 *     entityId: '42', userId: '42', subRole: null,
 *     status: 'active', requiresProfileSetup: false,
 *   });
 *
 *   const deps = buildAuthDeps({ repo });
 *   await verifyOtp(deps, { ... });
 *
 *   // assert a login event was inserted
 *   expect(repo.loginEvents).toHaveLength(1);
 *   expect(repo.loginEvents[0]?.outcome).toBe('success');
 *
 * All internal state is exposed as plain arrays/Maps for easy assertion.
 * ==============================================================================
 */

import type {
  IAuthRepository,
  OtpEventInsert,
  LoginEventInsert,
  DlrUpdate,
} from '../../ports/IAuthRepository.js';
import type { MobileFlags } from '../../repository/mobile-registry.js';
import type { ResolvedUser, UserProfileDto, AuthSessionRow } from '../../types.js';
import type { CreateSessionInput } from '../../repository/sessions.js';
import type { UserRole } from '../../../../shared/rbac/roles.js';

/* --------------------------------------------------------------------------
 * Seed shapes
 * -------------------------------------------------------------------------- */

type SeedUser = ResolvedUser & { mobile: string };

/* --------------------------------------------------------------------------
 * Default placeholder profile — returned by loadProfile when no seed given
 * -------------------------------------------------------------------------- */

function defaultProfile(entityId: string): UserProfileDto {
  return {
    id: entityId,
    displayName: 'Test User',
    email: null,
    phoneIndia: '+919999999999',
    phoneGlobal: '+919999999999',
    memberSince: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------------------
 * Implementation
 * -------------------------------------------------------------------------- */

export class InMemoryAuthRepository implements IAuthRepository {
  // ── Recorded calls (assert in tests) ────────────────────────────────────

  readonly otpEvents: OtpEventInsert[] = [];
  readonly loginEvents: LoginEventInsert[] = [];
  readonly dlrUpdates: DlrUpdate[] = [];
  readonly createdSessions: CreateSessionInput[] = [];
  readonly revokedSessions: Array<{ jti: string; reason: string }> = [];

  // ── Seeded state ─────────────────────────────────────────────────────────

  private readonly _users = new Map<string, SeedUser>(); // key: `${role}:${mobile}`
  private readonly _mobileFlags = new Map<string, MobileFlags>();
  private readonly _sessions = new Map<string, AuthSessionRow>(); // key: jti
  private readonly _profiles = new Map<string, UserProfileDto>(); // key: `${role}:${entityId}`
  private _nextCustomerId = 1000;

  // ── Seed helpers (test use only) ─────────────────────────────────────────

  seedUser(u: SeedUser): void {
    this._users.set(`${u.role}:${u.mobile}`, u);
  }

  seedMobileFlags(mobile: string, flags: Partial<MobileFlags>): void {
    this._mobileFlags.set(mobile, {
      mobile,
      verify_failure_count: 0,
      verify_locked_until: null,
      captcha_required_until: null,
      admin_blocked: 0,
      admin_blocked_reason: null,
      ...flags,
    });
  }

  seedSession(row: AuthSessionRow): void {
    this._sessions.set(row.jti, row);
  }

  seedProfile(role: UserRole, entityId: string, profile: Partial<UserProfileDto>): void {
    this._profiles.set(`${role}:${entityId}`, {
      ...defaultProfile(entityId),
      ...profile,
    });
  }

  reset(): void {
    this.otpEvents.length = 0;
    this.loginEvents.length = 0;
    this.dlrUpdates.length = 0;
    this.createdSessions.length = 0;
    this.revokedSessions.length = 0;
    this._users.clear();
    this._mobileFlags.clear();
    this._sessions.clear();
    this._profiles.clear();
    this._nextCustomerId = 1000;
  }

  // ── IAuthRepository ───────────────────────────────────────────────────────

  // mobile_registry
  async getMobileFlags(mobile: string): Promise<MobileFlags | null> {
    return this._mobileFlags.get(mobile) ?? null;
  }

  async touchMobileRegistry(_mobile: string): Promise<void> {
    // no-op in tests
  }

  async incrementVerifyFailure(mobile: string): Promise<number> {
    const existing = this._mobileFlags.get(mobile);
    const current = existing?.verify_failure_count ?? 0;
    const next = current + 1;
    this._mobileFlags.set(mobile, {
      mobile,
      verify_failure_count: next,
      verify_locked_until: existing?.verify_locked_until ?? null,
      captcha_required_until: existing?.captcha_required_until ?? null,
      admin_blocked: existing?.admin_blocked ?? 0,
      admin_blocked_reason: existing?.admin_blocked_reason ?? null,
    });
    return next;
  }

  async lockMobile(mobile: string, until: Date, captchaUntil: Date): Promise<void> {
    const existing = this._mobileFlags.get(mobile);
    this._mobileFlags.set(mobile, {
      mobile,
      verify_failure_count: existing?.verify_failure_count ?? 0,
      verify_locked_until: until,
      captcha_required_until: captchaUntil,
      admin_blocked: existing?.admin_blocked ?? 0,
      admin_blocked_reason: existing?.admin_blocked_reason ?? null,
    });
  }

  async resetVerifyFailure(mobile: string): Promise<void> {
    const existing = this._mobileFlags.get(mobile);
    if (!existing) return;
    this._mobileFlags.set(mobile, {
      ...existing,
      verify_failure_count: 0,
      verify_locked_until: null,
    });
  }

  // users
  async findUserByPhone(role: UserRole, mobile: string): Promise<ResolvedUser | null> {
    return this._users.get(`${role}:${mobile}`) ?? null;
  }

  async createCustomerShell(mobile: string): Promise<ResolvedUser> {
    const entityId = String(this._nextCustomerId++);
    const user: SeedUser = {
      mobile,
      role: 'customer',
      entityId,
      userId: entityId,
      subRole: null,
      status: 'active',
      requiresProfileSetup: true,
    };
    this._users.set(`customer:${mobile}`, user);
    return user;
  }

  // profiles
  async loadProfile(role: UserRole, entityId: string): Promise<UserProfileDto> {
    return this._profiles.get(`${role}:${entityId}`) ?? defaultProfile(entityId);
  }

  async loadIdentityDetails(
    role: UserRole,
    entityId: string,
  ): Promise<{ profile: UserProfileDto; requiresProfileSetup: boolean } | null> {
    // Find any seeded user with this role + entityId to get requiresProfileSetup
    const user = [...this._users.values()].find(u => u.role === role && u.entityId === entityId);
    if (!user) return null;
    const profile = this._profiles.get(`${role}:${entityId}`) ?? defaultProfile(entityId);
    return { profile, requiresProfileSetup: user.requiresProfileSetup };
  }

  // sessions
  async createSession(input: CreateSessionInput): Promise<void> {
    this.createdSessions.push(input);
    // Also store so findSessionByJti works in the same test
    this._sessions.set(input.jti, {
      id: this.createdSessions.length,
      jti: input.jti,
      role: input.role,
      entity_id: input.entityId,
      sub_role: input.subRole,
      refresh_token_hash: input.refreshTokenHash,
      previous_jti: input.previousJti,
      device_id: input.device.id,
      device_name: input.device.name,
      platform: input.device.platform,
      app_version: input.device.appVersion,
      ip: null,
      user_agent: input.userAgent,
      issued_at: new Date(),
      last_used_at: null,
      expires_at: input.expiresAt,
      revoked_at: null,
      revoked_reason: null,
    });
  }

  async findSessionByJti(jti: string): Promise<AuthSessionRow | null> {
    return this._sessions.get(jti) ?? null;
  }

  async markSessionRevoked(jti: string, reason: string): Promise<void> {
    this.revokedSessions.push({ jti, reason });
    const row = this._sessions.get(jti);
    if (row) {
      this._sessions.set(jti, { ...row, revoked_at: new Date(), revoked_reason: reason });
    }
  }

  async revokeAllForEntity(role: UserRole, entityId: string, reason: string): Promise<string[]> {
    const jtis: string[] = [];
    for (const [jti, row] of this._sessions) {
      if (row.role === role && row.entity_id === entityId && row.revoked_at === null) {
        jtis.push(jti);
        this._sessions.set(jti, { ...row, revoked_at: new Date(), revoked_reason: reason });
        this.revokedSessions.push({ jti, reason });
      }
    }
    return jtis;
  }

  async rotateSession(oldJti: string, next: CreateSessionInput): Promise<void> {
    await this.markSessionRevoked(oldJti, 'rotation');
    await this.createSession(next);
  }

  // audit
  async insertOtpEvent(e: OtpEventInsert): Promise<void> {
    this.otpEvents.push(e);
  }

  async insertLoginEvent(e: LoginEventInsert): Promise<void> {
    this.loginEvents.push(e);
  }

  async applyDlr(update: DlrUpdate): Promise<number> {
    this.dlrUpdates.push(update);
    return 1; // always succeeds in tests unless overridden
  }
}
