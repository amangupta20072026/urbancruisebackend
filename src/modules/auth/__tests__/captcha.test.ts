/**
 * Post-lockout CAPTCHA gate — audit item #10.
 * Before the fix, captcha_required_until was written but never read, and
 * captchaToken was accepted but never checked: a control that only looked
 * like protection.
 */
import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';

vi.mock('../../../shared/providers/msg91/otp.js', () => ({ dispatchOtp: vi.fn() }));

import { sendOtp } from '../service/otp-send.js';
import { buildAuthDeps } from '../infrastructure/AuthContainer.js';
import { HCaptchaVerifier, DisabledCaptchaVerifier } from '../infrastructure/HCaptchaVerifier.js';
import {
  InMemoryOtpSessionStore,
  InMemoryAuthRepository,
  SpyAuditSink,
} from '../infrastructure/testing/index.js';
import type { CaptchaVerdict, ICaptchaVerifier } from '../ports/ICaptchaVerifier.js';

const { dispatchOtp } = await import('../../../shared/providers/msg91/otp.js');
const mockDispatch = dispatchOtp as MockedFunction<typeof dispatchOtp>;

const MOBILE = '919812345678';
const params = (extra: Record<string, unknown> = {}) => ({
  phone: '9812345678',
  countryCode: '+91' as const,
  role: 'customer' as const,
  idempotencyKey: null,
  ip: '203.0.113.7',
  ...extra,
});

class FakeVerifier implements ICaptchaVerifier {
  readonly enabled = true;
  calls: Array<{ token: string; ip: string | null }> = [];
  constructor(private readonly verdict: CaptchaVerdict) {}
  async verify(token: string, ip: string | null): Promise<CaptchaVerdict> {
    this.calls.push({ token, ip });
    return this.verdict;
  }
}

describe('sendOtp — post-lockout CAPTCHA gate', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;
  let auditSink: SpyAuditSink;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
    auditSink = new SpyAuditSink();
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue({ ok: true, providerRequestId: 'r', attempts: 1 });
    // The number is inside its CAPTCHA window (set by a previous lock).
    repo.seedMobileFlags(MOBILE, { captcha_required_until: new Date(Date.now() + 3_600_000) });
  });

  const deps = (captcha: ICaptchaVerifier) =>
    buildAuthDeps({ store, repo, audit: auditSink, captcha });

  it('without a token → 400 captcha_required, no SMS, no quota spent', async () => {
    const err = await sendOtp(deps(new FakeVerifier({ ok: true })), params()).catch(e => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'captcha_required' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(store.sendCounts10m.get(MOBILE)).toBeUndefined();
    expect(store.lastSentAt.has(MOBILE)).toBe(false);
  });

  it('with a valid token → OTP is sent, token + IP passed to the verifier', async () => {
    const v = new FakeVerifier({ ok: true });
    await expect(sendOtp(deps(v), params({ captchaToken: 'tok-1' }))).resolves.toHaveProperty(
      'requestId',
    );
    expect(v.calls).toEqual([{ token: 'tok-1', ip: '203.0.113.7' }]);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('with an invalid token → 400 captcha_required, no SMS', async () => {
    const v = new FakeVerifier({
      ok: false,
      reason: 'invalid',
      providerCodes: ['invalid-input-response'],
    });
    const err = await sendOtp(deps(v), params({ captchaToken: 'bad' })).catch(e => e);
    expect(err).toMatchObject({ statusCode: 400, code: 'captcha_required' });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(auditSink.ofType('send_failed')[0]?.msg).toContain('captcha_invalid');
  });

  it('provider unreachable → fails CLOSED with 503, no SMS', async () => {
    const v = new FakeVerifier({ ok: false, reason: 'unavailable' });
    const err = await sendOtp(deps(v), params({ captchaToken: 'tok' })).catch(e => e);
    expect(err).toMatchObject({ statusCode: 503, code: 'service_unavailable' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('after the window expires, no CAPTCHA is needed', async () => {
    repo.seedMobileFlags(MOBILE, { captcha_required_until: new Date(Date.now() - 1000) });
    const v = new FakeVerifier({ ok: false, reason: 'invalid', providerCodes: [] });
    await expect(sendOtp(deps(v), params())).resolves.toHaveProperty('requestId');
    expect(v.calls).toHaveLength(0);
  });

  it('numbers that were never locked are never asked', async () => {
    repo.reset();
    const v = new FakeVerifier({ ok: false, reason: 'invalid', providerCodes: [] });
    await expect(sendOtp(deps(v), params())).resolves.toHaveProperty('requestId');
    expect(v.calls).toHaveLength(0);
  });

  it('gate OFF (no HCAPTCHA_SECRET) → old behaviour, OTP is sent', async () => {
    await expect(sendOtp(deps(new DisabledCaptchaVerifier()), params())).resolves.toHaveProperty(
      'requestId',
    );
  });

  it('default container has the gate OFF when HCAPTCHA_SECRET is unset', () => {
    expect(buildAuthDeps({ store, repo, audit: auditSink }).captcha.enabled).toBe(false);
  });
});

describe('HCaptchaVerifier', () => {
  it('sends secret, token, remoteip and sitekey as a form; success → ok', async () => {
    let sent: URLSearchParams | undefined;
    let url = '';
    const v = new HCaptchaVerifier('s3cret', 'site-key-1', async (u, form) => {
      url = u;
      sent = form;
      return { success: true };
    });
    expect(await v.verify('tok', '1.2.3.4')).toEqual({ ok: true });
    expect(url).toBe('https://api.hcaptcha.com/siteverify');
    expect(Object.fromEntries(sent!)).toEqual({
      secret: 's3cret',
      response: 'tok',
      remoteip: '1.2.3.4',
      sitekey: 'site-key-1',
    });
  });

  it('success:false → invalid with provider codes', async () => {
    const v = new HCaptchaVerifier('s', null, async () => ({
      success: false,
      'error-codes': ['invalid-input-response', 42],
    }));
    expect(await v.verify('tok', null)).toEqual({
      ok: false,
      reason: 'invalid',
      providerCodes: ['invalid-input-response'],
    });
  });

  it('network error / timeout → unavailable (never throws)', async () => {
    const v = new HCaptchaVerifier('s', null, async () => {
      throw new Error('ETIMEDOUT');
    });
    expect(await v.verify('tok', null)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('malformed reply → unavailable, never treated as success', async () => {
    for (const reply of [null, 'OK', {}, { success: 'true' }]) {
      const v = new HCaptchaVerifier('s', null, async () => reply);
      const r = await v.verify('tok', null);
      expect(r.ok).toBe(false);
    }
  });

  it('omits remoteip and sitekey when not provided', async () => {
    let sent: URLSearchParams | undefined;
    const v = new HCaptchaVerifier('s', null, async (_u, form) => {
      sent = form;
      return { success: true };
    });
    await v.verify('tok', null);
    expect([...sent!.keys()].sort()).toEqual(['response', 'secret']);
  });
});
