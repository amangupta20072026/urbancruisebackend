/**
 * auth.service — verifyOtp unit tests
 *
 * Covers every code path in service/otp-verify.ts
 * Fakes: InMemoryOtpSessionStore, InMemoryAuthRepository, SpyAuditSink
 * No Redis, no MySQL, no JWT secrets validation at module load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyOtp } from '../service/otp-verify.js';
import { buildAuthDeps } from '../infrastructure/AuthContainer.js';
import {
  InMemoryOtpSessionStore,
  InMemoryAuthRepository,
  SpyAuditSink,
} from '../infrastructure/testing/index.js';
import { hashOtp } from '../service/otp-hash.js';
import { RateLimitError } from '../../../shared/errors/index.js';
import { VERIFY_FAIL_LOCK_THRESHOLD, OTP_MAX_VERIFY_ATTEMPTS } from '../../../config/constants.js';
import type { OtpSession, VerifyOtpResponseDto, AuthenticatedResponseDto } from '../types.js';

/* --------------------------------------------------------------------------
 * Shared test fixtures
 * -------------------------------------------------------------------------- */

const MOBILE_10 = '9812345678'; // 10-digit as client sends
const MOBILE_E164 = '919812345678'; // internal normalised form
const COUNTRY_CODE = '+91' as const;
const OTP = '654321';
const REQUEST_ID = 'test-request-id-001';

const DEVICE = {
  id: 'device-1',
  name: 'iPhone 15',
  platform: 'ios' as const,
  appVersion: '1.0.0',
};

function makeSession(overrides: Partial<OtpSession> = {}): OtpSession {
  const requestId = overrides.requestId ?? REQUEST_ID;
  return {
    requestId,
    mobile: MOBILE_E164,
    otpHash: hashOtp(requestId, OTP),
    role: 'customer',
    channel: 'sms',
    isTest: false,
    attempts: 0,
    sentAt: Date.now(),
    ...overrides,
  };
}

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    phone: MOBILE_10,
    countryCode: COUNTRY_CODE,
    role: 'customer' as const,
    otp: OTP,
    requestId: REQUEST_ID,
    device: DEVICE,
    ip: '203.0.113.1',
    userAgent: 'UrbanCruise/1.0',
    ...overrides,
  };
}

function asAuthenticated(r: VerifyOtpResponseDto): AuthenticatedResponseDto {
  if (r.status !== 'authenticated') throw new Error(`expected authenticated, got ${r.status}`);
  return r;
}

/* --------------------------------------------------------------------------
 * Test suite
 * -------------------------------------------------------------------------- */

describe('verifyOtp', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;
  let auditSink: SpyAuditSink;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
    auditSink = new SpyAuditSink();

    // Seed a valid OTP session and an active customer by default
    store.seedOtpSession(makeSession());
    repo.seedUser({
      mobile: MOBILE_E164,
      role: 'customer',
      entityId: '42',
      userId: '42',
      subRole: null,
      status: 'active',
      requiresProfileSetup: false,
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('returns tokens and profile on valid OTP', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = asAuthenticated(await verifyOtp(deps, makeParams()));

    expect(result.status).toBe('authenticated');
    expect(result.accessToken).toBeTypeOf('string');
    expect(result.refreshToken).toBeTypeOf('string');
    expect(result.role).toBe('customer');
    expect(result.entityId).toBe('42');
    expect(result.requiresProfileSetup).toBe(false);
    expect(result.profile).toBeDefined();
  });

  it('deletes the OTP session after successful verify (single-use)', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    expect(store.sessions.has(REQUEST_ID)).toBe(false);
  });

  it('creates an auth_sessions row on success', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    expect(repo.createdSessions).toHaveLength(1);
    expect(repo.createdSessions[0]?.role).toBe('customer');
    expect(repo.createdSessions[0]?.entityId).toBe('42');
  });

  it('adds the jti to active sessions on success', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    // The jti is the sid inside the access token — we can verify sessions were registered
    expect(store.activeSessions.size).toBe(1);
    // The set has exactly one jti
    const sessionSet = store.getActiveSessions('customer', '42');
    expect(sessionSet.size).toBe(1);
  });

  it('inserts a login_events row with outcome=success', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    const loginEv = repo.loginEvents.find(e => e.outcome === 'success');
    expect(loginEv).toBeDefined();
    expect(loginEv?.mobile).toBe(MOBILE_E164);
    expect(loginEv?.role).toBe('customer');
  });

  it('emits a verify_succeeded audit event', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    expect(auditSink.ofType('verify_succeeded')).toHaveLength(1);
  });

  it('resets verify_failure_count on success', async () => {
    repo.seedMobileFlags(MOBILE_E164, { verify_failure_count: 3 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams());
    const flags = await repo.getMobileFlags(MOBILE_E164);
    expect(flags?.verify_failure_count).toBe(0);
  });

  // ── New customer → onboarding (NO account created) ──────────────────────

  it('returns onboarding_required for a new customer and creates NOTHING', async () => {
    repo.reset();
    store.seedOtpSession(makeSession());
    const deps = buildAuthDeps({ store, repo, audit: auditSink });

    const result = await verifyOtp(deps, makeParams());
    expect(result.status).toBe('onboarding_required');
    if (result.status !== 'onboarding_required') return;
    expect(result.onboardingToken.length).toBeGreaterThanOrEqual(40);
    expect(result.expiresInSeconds).toBeGreaterThan(0);
    // No customer row, no session, no tokens
    expect(repo.createdCustomers).toHaveLength(0);
    expect(repo.createdSessions).toHaveLength(0);
    expect('accessToken' in result).toBe(false);
  });

  it('stores the onboarding ticket hashed, bound to mobile + device', async () => {
    repo.reset();
    store.seedOtpSession(makeSession());
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await verifyOtp(deps, makeParams());
    if (result.status !== 'onboarding_required') throw new Error('expected onboarding');

    expect(store.onboardingTickets.size).toBe(1);
    const [key, ticket] = [...store.onboardingTickets.entries()][0]!;
    expect(key).not.toBe(result.onboardingToken); // stored as a hash
    expect(ticket.mobile).toBe(MOBILE_E164);
    expect(ticket.deviceId).toBe(DEVICE.id);
  });

  it('existing customer goes straight to authenticated (no onboarding)', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await verifyOtp(deps, makeParams());
    expect(result.status).toBe('authenticated');
    expect(store.onboardingTickets.size).toBe(0);
  });

  // ── Missing/expired OTP session ───────────────────────────────────────────

  it('throws OTP_EXPIRED when requestId is absent', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams({ requestId: undefined }))).rejects.toMatchObject({
      code: 'otp_expired',
    });
  });

  it('throws OTP_EXPIRED when session does not exist', async () => {
    store.sessions.clear(); // remove the seeded session
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({ code: 'otp_expired' });
  });

  // ── Wrong OTP ─────────────────────────────────────────────────────────────

  it('throws OTP_INVALID on wrong code', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams({ otp: '000000' }))).rejects.toMatchObject({
      code: 'otp_invalid',
    });
  });

  it('emits a verify_failed audit event on wrong code', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
    expect(auditSink.ofType('verify_failed')).toHaveLength(1);
  });

  it('increments verify_failure_count in DB on wrong code', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
    const flags = await repo.getMobileFlags(MOBILE_E164);
    expect(flags?.verify_failure_count).toBe(1);
  });

  it('increments the Redis fast counter on wrong code', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
    expect(store.verifyFails.get(MOBILE_E164)).toBe(1);
  });

  it('locks mobile and clears Redis counter after crossing threshold', async () => {
    // Windowed Redis counter is the authority: seed threshold - 1
    store.verifyFails.set(MOBILE_E164, VERIFY_FAIL_LOCK_THRESHOLD - 1);

    // Seed multiple OTP sessions so we can retry
    for (let i = 0; i < VERIFY_FAIL_LOCK_THRESHOLD; i++) {
      store.seedOtpSession(makeSession({ requestId: `req-${i}` }));
    }

    const deps = buildAuthDeps({ store, repo, audit: auditSink });

    // One wrong attempt crosses the threshold
    await verifyOtp(deps, makeParams({ otp: '000000', requestId: 'req-0' })).catch(() => null);

    const flags = await repo.getMobileFlags(MOBILE_E164);
    expect(flags?.verify_locked_until).toBeDefined();
    expect(flags?.verify_locked_until).toBeInstanceOf(Date);
    // Redis counter is cleared after lock
    expect(store.verifyFails.get(MOBILE_E164)).toBeUndefined();
  });

  it('resets the DB failure count when locking (no permanent hair-trigger)', async () => {
    repo.seedMobileFlags(MOBILE_E164, { verify_failure_count: 40 });
    store.verifyFails.set(MOBILE_E164, VERIFY_FAIL_LOCK_THRESHOLD - 1);
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
    const flags = await repo.getMobileFlags(MOBILE_E164);
    expect(flags?.verify_failure_count).toBe(0);
  });

  it('a stale DB failure count alone does NOT lock the number', async () => {
    repo.seedMobileFlags(MOBILE_E164, { verify_failure_count: 40 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
    const flags = await repo.getMobileFlags(MOBILE_E164);
    expect(flags?.verify_locked_until).toBeNull();
  });

  it('rejects a correct OTP replayed against a different requestId', async () => {
    store.sessions.clear();
    // Session whose hash was computed for another request id
    store.seedOtpSession({ ...makeSession(), otpHash: hashOtp('other-request', OTP) });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({ code: 'otp_invalid' });
  });

  // ── Mobile locked ─────────────────────────────────────────────────────────

  it('throws ACCOUNT_LOCKED when mobile is locked', async () => {
    repo.seedMobileFlags(MOBILE_E164, {
      verify_locked_until: new Date(Date.now() + 10 * 60 * 1000), // 10 min from now
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const err = (await verifyOtp(deps, makeParams()).catch(e => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('account_locked');
    expect(err.retryAfter).toBeGreaterThan(0);
  });

  it('allows verify when lock has expired', async () => {
    repo.seedMobileFlags(MOBILE_E164, {
      verify_locked_until: new Date(Date.now() - 1000), // 1 s in the past
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).resolves.toBeDefined();
  });

  // ── Session mobile/role mismatch ──────────────────────────────────────────

  it('throws OTP_INVALID when session mobile does not match', async () => {
    store.sessions.clear();
    store.seedOtpSession(makeSession({ mobile: '911111111111' })); // different mobile
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({ code: 'otp_invalid' });
  });

  it('throws OTP_INVALID when session role does not match', async () => {
    store.sessions.clear();
    store.seedOtpSession(makeSession({ role: 'driver' }));
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({ code: 'otp_invalid' });
  });

  // ── Suspended / deleted account ───────────────────────────────────────────

  it('throws ACCOUNT_SUSPENDED for an inactive account', async () => {
    repo.reset();
    store.seedOtpSession(makeSession());
    repo.seedUser({
      mobile: MOBILE_E164,
      role: 'customer',
      entityId: '99',
      userId: '99',
      subRole: null,
      status: 'inactive',
      requiresProfileSetup: false,
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({
      code: 'account_suspended',
    });
  });

  it('inserts a login_event with outcome=account_suspended', async () => {
    repo.reset();
    store.seedOtpSession(makeSession());
    repo.seedUser({
      mobile: MOBILE_E164,
      role: 'customer',
      entityId: '99',
      userId: '99',
      subRole: null,
      status: 'inactive',
      requiresProfileSetup: false,
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await verifyOtp(deps, makeParams()).catch(() => null);
    const ev = repo.loginEvents.find(e => e.outcome === 'account_suspended');
    expect(ev).toBeDefined();
  });

  // ── Non-customer role not provisioned ─────────────────────────────────────

  it('throws ACCOUNT_NOT_PROVISIONED for an unprovisioned vendor', async () => {
    store.sessions.clear();
    store.seedOtpSession(makeSession({ role: 'vendor' }));
    // No vendor seeded in repo
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(verifyOtp(deps, makeParams({ role: 'vendor' }))).rejects.toMatchObject({
      code: 'account_not_provisioned',
    });
  });

  it('never creates a vendor/driver/uc account', async () => {
    for (const role of ['vendor', 'driver', 'uc'] as const) {
      store.sessions.clear();
      store.seedOtpSession(makeSession({ role }));
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      await verifyOtp(deps, makeParams({ role })).catch(() => null);
    }
    expect(repo.createdCustomers).toHaveLength(0);
    expect(repo.createdSessions).toHaveLength(0);
    expect(store.onboardingTickets.size).toBe(0);
  });

  it('logs in an existing active vendor', async () => {
    store.sessions.clear();
    store.seedOtpSession(makeSession({ role: 'vendor' }));
    repo.seedUser({
      mobile: MOBILE_E164,
      role: 'vendor',
      entityId: '7',
      userId: '7',
      subRole: 'owner',
      status: 'active',
      requiresProfileSetup: false,
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = asAuthenticated(await verifyOtp(deps, makeParams({ role: 'vendor' })));
    expect(result.role).toBe('vendor');
    expect(result.subRole).toBe('owner');
  });

  /* ==========================================================================
   * REGRESSION — audit item #2 (OTP brute force via parallel guesses).
   * Before the fix, 200 parallel wrong guesses were ALL compared against the
   * hash, defeating the 5-attempt lock.
   * ========================================================================== */
  describe('per-OTP attempt cap (audit #2 regression)', () => {
    const wrongGuesses = (n: number) =>
      Array.from({ length: n }, (_, i) => String(100_000 + i)).filter(g => g !== OTP);

    it('of 200 parallel wrong guesses, at most OTP_MAX_VERIFY_ATTEMPTS are evaluated', async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      const results = await Promise.allSettled(
        wrongGuesses(200).map(otp => verifyOtp(deps, makeParams({ otp }))),
      );
      const compared = results.filter(
        r => r.status === 'rejected' && (r.reason as { code: string }).code === 'otp_invalid',
      ).length;
      expect(compared).toBeLessThanOrEqual(OTP_MAX_VERIFY_ATTEMPTS);
      expect(results.every(r => r.status === 'rejected')).toBe(true);
    });

    it('the CORRECT code is rejected once the attempt cap is exhausted', async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      store.otpAttempts.set(REQUEST_ID, OTP_MAX_VERIFY_ATTEMPTS);
      await expect(verifyOtp(deps, makeParams())).rejects.toMatchObject({ code: 'otp_expired' });
    });

    it('burns the session once the cap is exceeded (a fresh OTP is required)', async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      store.otpAttempts.set(REQUEST_ID, OTP_MAX_VERIFY_ATTEMPTS);
      await verifyOtp(deps, makeParams({ otp: '000000' })).catch(() => null);
      expect(store.sessions.has(REQUEST_ID)).toBe(false);
    });

    it('the correct code still works within the cap', async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      store.otpAttempts.set(REQUEST_ID, OTP_MAX_VERIFY_ATTEMPTS - 1);
      const r = await verifyOtp(deps, makeParams());
      expect(r.status).toBe('authenticated');
    });

    it('two parallel verifies with the CORRECT code mint only ONE session', async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      const results = await Promise.allSettled([
        verifyOtp(deps, makeParams()),
        verifyOtp(deps, makeParams()),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(store.getActiveSessions('customer', '42').size).toBe(1);
    });
  });
});
