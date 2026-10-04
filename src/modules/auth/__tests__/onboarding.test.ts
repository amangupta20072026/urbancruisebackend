/**
 * auth.service — customer onboarding (end-to-end through the service layer)
 *
 * Flow under test:
 *   verifyOtp (new customer) → onboarding_required + token
 *   completeCustomerOnboarding(token, details) → customer row + session
 *
 * Fakes: InMemoryOtpSessionStore, InMemoryAuthRepository, SpyAuditSink
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { verifyOtp } from '../service/otp-verify.js';
import { completeCustomerOnboarding } from '../service/onboarding.js';
import { hashOtp } from '../service/otp-hash.js';
import { buildAuthDeps, type AuthServiceDeps } from '../infrastructure/AuthContainer.js';
import {
  InMemoryOtpSessionStore,
  InMemoryAuthRepository,
  SpyAuditSink,
} from '../infrastructure/testing/index.js';
import { CustomerOnboardBody } from '../schemas.js';

const MOBILE_E164 = '919812345678';
const OTP = '654321';
const REQUEST_ID = 'req-onboard-1';
const DEVICE = {
  id: 'device-1',
  name: 'Pixel 9',
  platform: 'android' as const,
  appVersion: '1.0.0',
};
const DETAILS = { firstName: 'Aman', lastName: 'Gupta', email: 'aman@example.com' };

describe('customer onboarding', () => {
  let store: InMemoryOtpSessionStore;
  let repo: InMemoryAuthRepository;
  let deps: AuthServiceDeps;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
    repo = new InMemoryAuthRepository();
    deps = buildAuthDeps({ store, repo, audit: new SpyAuditSink() });
    store.seedOtpSession({
      requestId: REQUEST_ID,
      mobile: MOBILE_E164,
      otpHash: hashOtp(REQUEST_ID, OTP),
      role: 'customer',
      channel: 'sms',
      isTest: false,
      attempts: 0,
      sentAt: Date.now(),
    });
  });

  async function verifyNewCustomer(): Promise<string> {
    const res = await verifyOtp(deps, {
      phone: '9812345678',
      countryCode: '+91',
      role: 'customer',
      otp: OTP,
      requestId: REQUEST_ID,
      device: DEVICE,
      ip: '203.0.113.1',
      userAgent: 'UrbanCruise/1.0',
    });
    if (res.status !== 'onboarding_required') throw new Error('expected onboarding_required');
    return res.onboardingToken;
  }

  function onboard(token: string, device = DEVICE, details = DETAILS) {
    return completeCustomerOnboarding(deps, {
      onboardingToken: token,
      details: { firstName: details.firstName, lastName: details.lastName, email: details.email },
      device,
      ip: '203.0.113.1',
      userAgent: 'UrbanCruise/1.0',
    });
  }

  it('creates the customer ONLY after details are submitted, then logs in', async () => {
    const token = await verifyNewCustomer();
    expect(repo.createdCustomers).toHaveLength(0); // nothing yet

    const res = await onboard(token);

    expect(res.status).toBe('authenticated');
    expect(res.role).toBe('customer');
    expect(res.accessToken).toBeTypeOf('string');
    expect(res.refreshToken).toBeTypeOf('string');
    expect(repo.createdCustomers).toEqual([{ mobile: MOBILE_E164, details: DETAILS }]);
    expect(repo.createdSessions).toHaveLength(1);
    expect(repo.loginEvents.some(e => e.outcome === 'success')).toBe(true);
  });

  it('the onboarding token is single-use', async () => {
    const token = await verifyNewCustomer();
    await onboard(token);
    await expect(onboard(token)).rejects.toMatchObject({ code: 'onboarding_expired' });
    expect(repo.createdCustomers).toHaveLength(1);
  });

  it('rejects an unknown / expired token', async () => {
    await expect(onboard('x'.repeat(43))).rejects.toMatchObject({
      code: 'onboarding_expired',
      statusCode: 401,
    });
    expect(repo.createdCustomers).toHaveLength(0);
  });

  it('rejects a token presented from a different device', async () => {
    const token = await verifyNewCustomer();
    await expect(onboard(token, { ...DEVICE, id: 'attacker-device' })).rejects.toMatchObject({
      code: 'onboarding_invalid',
    });
    expect(repo.createdCustomers).toHaveLength(0);
  });

  it('never duplicates: if the number now exists, logs into THAT customer', async () => {
    const token = await verifyNewCustomer();
    // CRM creates the customer while the user is filling the form
    repo.seedUser({
      mobile: MOBILE_E164,
      role: 'customer',
      entityId: '7001',
      userId: '7001',
      subRole: null,
      status: 'active',
      requiresProfileSetup: false,
    });

    const res = await onboard(token);
    expect(res.entityId).toBe('7001');
    expect(repo.createdCustomers).toHaveLength(0);
  });

  it('blocks onboarding if the number was admin-blocked after OTP', async () => {
    const token = await verifyNewCustomer();
    repo.seedMobileFlags(MOBILE_E164, { admin_blocked: 1 });
    await expect(onboard(token)).rejects.toMatchObject({ code: 'mobile_blocked' });
    expect(repo.createdCustomers).toHaveLength(0);
  });

  it('a returning customer (onboarded earlier) skips onboarding on next login', async () => {
    const token = await verifyNewCustomer();
    await onboard(token);

    store.seedOtpSession({
      requestId: 'req-2',
      mobile: MOBILE_E164,
      otpHash: hashOtp('req-2', OTP),
      role: 'customer',
      channel: 'sms',
      isTest: false,
      attempts: 0,
      sentAt: Date.now(),
    });
    const second = await verifyOtp(deps, {
      phone: '9812345678',
      countryCode: '+91',
      role: 'customer',
      otp: OTP,
      requestId: 'req-2',
      device: DEVICE,
      ip: null,
      userAgent: null,
    });
    expect(second.status).toBe('authenticated');
  });
});

describe('CustomerOnboardBody validation', () => {
  const base = { onboardingToken: 't'.repeat(43), device: DEVICE };

  it('requires a first name and trims it', () => {
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: '   ' }).success).toBe(false);
    const ok = CustomerOnboardBody.parse({ ...base, firstName: '  Aman ' });
    expect(ok.firstName).toBe('Aman');
    expect(ok.lastName).toBeNull();
    expect(ok.email).toBeNull();
  });

  it('accepts Hindi / accented names, rejects digits and markup', () => {
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: 'अमन' }).success).toBe(true);
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: "D'Souza" }).success).toBe(true);
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: 'Aman1' }).success).toBe(false);
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: '<b>x</b>' }).success).toBe(false);
  });

  it('enforces column lengths and email format', () => {
    expect(CustomerOnboardBody.safeParse({ ...base, firstName: 'a'.repeat(51) }).success).toBe(
      false,
    );
    expect(
      CustomerOnboardBody.safeParse({ ...base, firstName: 'Aman', email: 'not-an-email' }).success,
    ).toBe(false);
    expect(CustomerOnboardBody.parse({ ...base, firstName: 'Aman', email: '' }).email).toBeNull();
  });
});
