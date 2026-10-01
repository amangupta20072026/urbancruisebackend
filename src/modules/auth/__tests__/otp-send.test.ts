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
    // The hash should be sha256 of '123456' (MSG91_TEST_OTP from setup.ts)
    const { sha256 } = await import('../../../shared/utils/crypto.js');
    expect(session?.otpHash).toBe(sha256('123456'));
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

  // ── Silent drop (non-customer role not provisioned) ───────────────────────

  it('silently drops an unprovisioned vendor (does not 401, returns same shape)', async () => {
    // No vendor seeded in repo
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    const result = await sendOtp(deps, makeParams({ role: 'vendor' }));

    // Response shape is identical to a real send — attacker cannot enumerate
    expect(result.requestId).toBeTypeOf('string');
    expect(result.channel).toBe('sms');
    // MSG91 was NOT called
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('emits account_not_provisioned audit event on silent drop', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams({ role: 'vendor' }));
    expect(auditSink.ofType('account_not_provisioned')).toHaveLength(1);
  });

  it('still increments rate-limit counters on silent drop (prevents free probing)', async () => {
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams({ role: 'vendor' }));
    expect(store.sendCounts10m.get('919812345678')).toBe(1);
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

  it('does NOT increment rate-limit counters on dispatch failure', async () => {
    mockDispatch.mockResolvedValue({ ok: false, failure: 'timeout', attempts: 1 });
    const deps = buildAuthDeps({ store, repo, audit: auditSink });
    await sendOtp(deps, makeParams()).catch(() => null);
    // audit sink has send_failed, but counters are NOT incremented
    // incrementSendCounters is only called after successful/silent sends
    expect(store.sendCounts10m.get('919812345678')).toBeUndefined();
  });
});
