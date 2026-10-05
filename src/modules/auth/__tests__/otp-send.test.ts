/**
 * auth.service — sendOtp unit tests
 *
 * MSG91's dispatchOtp is the only real external call in sendOtp — it is
 * mocked with vi.mock() at the module level. Everything else (Redis, MySQL)
 * is replaced with in-memory fakes.
 *
 * Fakes: InMemoryOtpSessionStore, InMemoryAuthRepository, SpyAuditSink
 */
import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';

// ── Mock MSG91 dispatch BEFORE importing anything that chains through it ──
vi.mock('../../../shared/providers/msg91/otp.js', () => ({
  dispatchOtp: vi.fn(),
}));

import { sendOtp } from '../service/otp-send.js';
import { buildAuthDeps } from '../infrastructure/AuthContainer.js';
import {
  InMemoryOtpSessionStore,
  InMemoryAuthRepository,
  SpyAuditSink,
} from '../infrastructure/testing/index.js';
import { ConflictError, RateLimitError } from '../../../shared/errors/index.js';
import { OTP_SEND_MAX_PER_10M, OTP_SEND_MAX_PER_DAY } from '../../../config/constants.js';
import type { OtpDispatchResult } from '../../../shared/providers/msg91/otp.js';

const { dispatchOtp } = await import('../../../shared/providers/msg91/otp.js');
const mockDispatch = dispatchOtp as MockedFunction<typeof dispatchOtp>;

/* --------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    phone: '9812345678',
    countryCode: '+91' as const,
    role: 'customer' as const,
    idempotencyKey: null,
    ip: '203.0.113.1',
    ...overrides,
  };
}

const SUCCESS_DISPATCH: OtpDispatchResult = {
  ok: true,
  providerRequestId: 'msg91-req-001',
  attempts: 1,
};

/* --------------------------------------------------------------------------
 * Test suite
 * -------------------------------------------------------------------------- */

describe('sendOtp', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;
  let auditSink: SpyAuditSink;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
    auditSink = new SpyAuditSink();
    mockDispatch.mockResolvedValue(SUCCESS_DISPATCH);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('returns a requestId, resendAfterSeconds, channel, testMode', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await sendOtp(deps, makeParams());

    expect(result.requestId).toBeTypeOf('string');
    expect(result.resendAfterSeconds).toBeGreaterThan(0);
    expect(result.channel).toBe('sms');
    expect(result.testMode).toBe(false);
  });

  it('stores an OTP session in the store', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await sendOtp(deps, makeParams());
    expect(store.sessions.has(result.requestId)).toBe(true);
    const session = store.sessions.get(result.requestId);
    expect(session?.mobile).toBe('919812345678');
    expect(session?.role).toBe('customer');
  });

  it('calls dispatchOtp once with the correct mobile', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith('919812345678', expect.any(String));
  });

  it('emits send_succeeded audit event', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams());
    expect(auditSink.ofType('send_succeeded')).toHaveLength(1);
  });

  it('increments send counters after success', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams());
    expect(store.sendCounts10m.get('919812345678')).toBe(1);
    expect(store.sendCountsDay.get('919812345678')).toBe(1);
  });

  // ── Test mobile path ─────────────────────────────────────────────────────

  it('does NOT call dispatchOtp for a test mobile', async () => {
    // '919000000000' is in MSG91_TEST_MOBILES from setup.ts
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await sendOtp(deps, makeParams({ phone: '9000000000' }));
    expect(result.testMode).toBe(true);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('returns testMode=true and the fixed OTP is stored hashed', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await sendOtp(deps, makeParams({ phone: '9000000000' }));
    const session = store.sessions.get(result.requestId);
    // HMAC of '123456' (MSG91_TEST_OTP from setup.ts) bound to this requestId
    const { hashOtp } = await import('../service/otp-hash.js');
    expect(session?.otpHash).toBe(hashOtp(result.requestId, '123456'));
    expect(session?.otpHash).not.toContain('123456');
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('replays the cached response on idempotent retry', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const KEY = 'idem-key-001';

    const first = await sendOtp(deps, makeParams({ idempotencyKey: KEY }));
    mockDispatch.mockClear(); // reset call count

    const second = await sendOtp(deps, makeParams({ idempotencyKey: KEY }));
    expect(second.requestId).toBe(first.requestId);
    expect(mockDispatch).not.toHaveBeenCalled(); // not dispatched again
  });

  it('throws IDEMPOTENCY_KEY_MISMATCH when key is reused with a different mobile', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const KEY = 'idem-key-002';

    await sendOtp(deps, makeParams({ idempotencyKey: KEY, phone: '9812345678' }));

    await expect(
      sendOtp(deps, makeParams({ idempotencyKey: KEY, phone: '9111111111' })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH' });
  });

  // ── Admin blocked ─────────────────────────────────────────────────────────

  it('throws MOBILE_BLOCKED when mobile is admin-blocked', async () => {
    repo.seedMobileFlags('919812345678', { admin_blocked: 1 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toMatchObject({
      code: 'mobile_blocked',
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('emits send_failed audit event when mobile is admin-blocked', async () => {
    repo.seedMobileFlags('919812345678', { admin_blocked: 1 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams()).catch(() => null);
    expect(auditSink.ofType('send_failed')).toHaveLength(1);
  });

  // ── Rate limit (pre-existing lock from DB) ────────────────────────────────

  it('throws ACCOUNT_LOCKED when mobile is verify-locked', async () => {
    repo.seedMobileFlags('919812345678', {
      verify_locked_until: new Date(Date.now() + 10 * 60 * 1_000),
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const err = (await sendOtp(deps, makeParams()).catch(e => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('account_locked');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  // ── Vendor / UC / Driver must pre-exist (explicit rejection) ─────────────

  for (const role of ['vendor', 'driver', 'uc'] as const) {
    it(`rejects an unregistered ${role} with ACCOUNT_NOT_PROVISIONED and sends no SMS`, async () => {
      const deps = buildAuthDeps({ store, repo, audit: auditSink });
      await expect(sendOtp(deps, makeParams({ role }))).rejects.toMatchObject({
        code: 'account_not_provisioned',
        statusCode: 403,
      });
      expect(mockDispatch).not.toHaveBeenCalled();
      expect(store.sessions.size).toBe(0);
    });
  }

  it('the rejection message tells the user to contact the administrator', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const err = (await sendOtp(deps, makeParams({ role: 'driver' })).catch(e => e)) as Error;
    expect(err.message).toMatch(/not registered as a driver/i);
    expect(err.message).toMatch(/administrator/i);
  });

  it('rejects an INACTIVE vendor (e.g. web app deactivated it) with ACCOUNT_SUSPENDED', async () => {
    repo.seedUser({
      mobile: '919812345678',
      role: 'vendor',
      entityId: '5',
      userId: '5',
      subRole: 'owner',
      status: 'inactive',
      requiresProfileSetup: false,
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams({ role: 'vendor' }))).rejects.toMatchObject({
      code: 'account_suspended',
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('sends an OTP to a registered, active UC staff member', async () => {
    repo.seedUser({
      mobile: '919812345678',
      role: 'uc',
      entityId: '3',
      userId: '3',
      subRole: null,
      status: 'active',
      requiresProfileSetup: false,
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const res = await sendOtp(deps, makeParams({ role: 'uc' }));
    expect(res.requestId).toBeTypeOf('string');
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it('emits account_not_provisioned audit event on rejection', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams({ role: 'vendor' })).catch(() => null);
    expect(auditSink.ofType('account_not_provisioned')).toHaveLength(1);
  });

  it('rejected lookups still burn rate-limit quota (prevents free probing)', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams({ role: 'vendor' })).catch(() => null);
    expect(store.sendCounts10m.get('919812345678')).toBe(1);
  });

  it('a rate-limited prober is stopped BEFORE the account lookup', async () => {
    store.sendCounts10m.set('919812345678', OTP_SEND_MAX_PER_10M);
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams({ role: 'vendor' }))).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it('sends an OTP to a NEW customer too (customers are never pre-checked)', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const res = await sendOtp(deps, makeParams({ role: 'customer' }));
    expect(res.requestId).toBeTypeOf('string');
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  // ── Send rate limits ──────────────────────────────────────────────────────

  it('throws 429 when 10-minute limit is reached', async () => {
    store.sendCounts10m.set('919812345678', OTP_SEND_MAX_PER_10M);
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toBeInstanceOf(RateLimitError);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('throws 429 when daily limit is reached', async () => {
    store.sendCountsDay.set('919812345678', OTP_SEND_MAX_PER_DAY);
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toBeInstanceOf(RateLimitError);
  });

  // ── MSG91 dispatch failures ───────────────────────────────────────────────

  it('throws ConflictError on MSG91 timeout after retry', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure: 'timeout',
      attempts: 2,
      errorMessage: 'Request timed out',
    });

    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toBeInstanceOf(ConflictError);
  });

  it('emits send_failed audit event on MSG91 failure', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure: 'network',
      attempts: 2,
    });

    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams()).catch(() => null);
    expect(auditSink.ofType('send_failed')).toHaveLength(1);
  });

  it('throws ServiceUnavailableError when circuit breaker is open', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure: 'circuit_open',
      attempts: 0,
    });

    const { ServiceUnavailableError } = await import('../../../shared/errors/index.js');
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('throws ServiceUnavailableError when MSG91 wallet is empty', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure: 'wallet_low',
      attempts: 1,
    });

    const { ServiceUnavailableError } = await import('../../../shared/errors/index.js');
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await expect(sendOtp(deps, makeParams())).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('refunds per-mobile quota and releases cooldown on dispatch failure', async () => {
    mockDispatch.mockResolvedValue({ ok: false, failure: 'timeout', attempts: 1 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams()).catch(() => null);
    // Reserved up front, then refunded because no SMS went out.
    expect(store.sendCounts10m.get('919812345678')).toBe(0);
    expect(store.sendCountsDay.get('919812345678')).toBe(0);
    expect(store.lastSentAt.has('919812345678')).toBe(false);
    // ...and no orphaned OTP session is left behind.
    expect(store.sessions.size).toBe(0);
  });

  it('user can retry immediately after a provider failure', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    mockDispatch.mockResolvedValueOnce({ ok: false, failure: 'timeout', attempts: 2 });
    await sendOtp(deps, makeParams()).catch(() => null);
    mockDispatch.mockResolvedValueOnce(SUCCESS_DISPATCH);
    await expect(sendOtp(deps, makeParams())).resolves.toMatchObject({ channel: 'sms' });
  });

  /* ==========================================================================
   * REGRESSION — audit item #1. Before the fix, 25 parallel requests for one
   * number produced 25 SMS despite the 30-second cooldown.
   * ========================================================================== */
  it('parallel requests for one number send exactly ONE SMS', async () => {
    mockDispatch.mockClear();
    mockDispatch.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20)); // realistic provider latency
      return SUCCESS_DISPATCH;
    });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => sendOtp(deps, makeParams())),
    );
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected.every(r => (r.reason as RateLimitError).code === 'send_cooldown')).toBe(true);
  });

  it('a number cannot receive more than OTP_SEND_MAX_PER_DAY SMS in a day', async () => {
    mockDispatch.mockClear();
    mockDispatch.mockResolvedValue(SUCCESS_DISPATCH);
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    for (let i = 0; i < OTP_SEND_MAX_PER_DAY + 5; i += 1) {
      store.lastSentAt.clear(); // simulate cooldown elapsing
      store.sendCounts10m.clear(); // simulate 10-minute window rolling
      await sendOtp(deps, makeParams()).catch(() => null);
    }
    expect(mockDispatch).toHaveBeenCalledTimes(OTP_SEND_MAX_PER_DAY);
  });
});

/* ==============================================================================
 * REGRESSION — audit item #9: provider error text must never reach the client.
 * ============================================================================== */
describe('sendOtp — provider errors are not leaked (audit #9 regression)', () => {
  const SECRET_PROVIDER_TEXT = 'Invalid authkey a1b2c3 for template 66f0e1 (account UC-PROD)';

  async function failWith(failure: NonNullable<OtpDispatchResult['failure']>) {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure,
      attempts: 1,
      errorCode: '418',
      errorMessage: SECRET_PROVIDER_TEXT,
    });
    const deps = buildAuthDeps({
      store: new InMemoryOtpSessionStore(),
      repo: new InMemoryAuthRepository(),
      audit: new SpyAuditSink(),
    });
    return (await sendOtp(deps, makeParams()).catch((e: unknown) => e)) as {
      message: string;
      code: string;
      statusCode: number;
      details?: unknown;
    };
  }

  it.each([
    ['provider_forbidden', 409, 'otp_send_failed'],
    ['template_bad', 409, 'otp_send_failed'],
    ['unknown', 409, 'otp_send_failed'],
    ['timeout', 409, 'otp_send_failed'],
    ['rate_limited', 409, 'provider_rate_limited'],
    ['wallet_low', 503, 'service_unavailable'],
    ['circuit_open', 503, 'service_unavailable'],
  ] as const)('%s → %i %s with a generic message', async (failure, status, code) => {
    const err = await failWith(failure);
    expect(err.statusCode).toBe(status); // contract unchanged
    expect(err.code).toBe(code); // contract unchanged
    expect(err.message).not.toContain('authkey');
    expect(JSON.stringify(err.details ?? null)).not.toContain('wallet');
    expect(err.message + JSON.stringify(err.details ?? null)).not.toContain(SECRET_PROVIDER_TEXT);
  });

  it('the raw provider text is still recorded in the audit trail for operators', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      failure: 'provider_forbidden',
      attempts: 1,
      errorMessage: SECRET_PROVIDER_TEXT,
    });
    const auditSink = new SpyAuditSink();
    const deps = buildAuthDeps({
      store: new InMemoryOtpSessionStore(),
      repo: new InMemoryAuthRepository(),
      audit: auditSink,
    });
    await sendOtp(deps, makeParams()).catch(() => null);
    expect(auditSink.ofType('send_failed')[0]?.msg).toBe(SECRET_PROVIDER_TEXT);
  });
});
