import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOtpSessionStore } from '../infrastructure/testing/InMemoryOtpSessionStore.js';
import { enforceSendRateLimits, incrementSendCounters } from '../service/rate-limits.js';
import { RateLimitError } from '../../../shared/errors/index.js';
import {
  OTP_SEND_MIN_INTERVAL_SECONDS,
  OTP_SEND_MAX_PER_10M,
  OTP_SEND_MAX_PER_DAY,
  OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR,
  OTP_SEND_MAX_PER_PREFIX_PER_HOUR,
} from '../../../config/constants.js';

const MOBILE = '919812345678';
const IP = '203.0.113.55';
const IP_KEY = 'v4:203.0.113';

async function enforceAndCatch(
  store: InMemoryOtpSessionStore,
  isTest = false,
): Promise<RateLimitError> {
  return (await enforceSendRateLimits(store, MOBILE, IP, isTest).catch(e => e)) as RateLimitError;
}

describe('enforceSendRateLimits', () => {
  let store: InMemoryOtpSessionStore;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
  });

  it('allows the first send (no prior state)', async () => {
    await expect(enforceSendRateLimits(store, MOBILE, IP, false)).resolves.toBeUndefined();
  });

  it('blocks when cooldown has not elapsed', async () => {
    store.lastSentAt.set(MOBILE, Date.now() - 5_000);
    await expect(enforceSendRateLimits(store, MOBILE, IP, false)).rejects.toThrow(RateLimitError);
    const err = await enforceAndCatch(store);
    expect(err.code).toBe('send_cooldown');
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(err.retryAfter).toBeLessThanOrEqual(OTP_SEND_MIN_INTERVAL_SECONDS);
  });

  it('allows after cooldown has elapsed', async () => {
    store.lastSentAt.set(MOBILE, Date.now() - (OTP_SEND_MIN_INTERVAL_SECONDS + 5) * 1_000);
    await expect(enforceSendRateLimits(store, MOBILE, IP, false)).resolves.toBeUndefined();
  });

  it('blocks when 10-minute window is exhausted', async () => {
    store.sendCounts10m.set(MOBILE, OTP_SEND_MAX_PER_10M);
    const err = await enforceAndCatch(store);
    expect(err.code).toBe('send_limit_10m');
    expect(err.retryAfter).toBe(600);
  });

  it('blocks when daily limit is exhausted', async () => {
    store.sendCountsDay.set(MOBILE, OTP_SEND_MAX_PER_DAY);
    const err = await enforceAndCatch(store);
    expect(err.code).toBe('send_limit_day');
    expect(err.retryAfter).toBe(86_400);
  });

  it('blocks when IP-block cap is exhausted', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR);
    const err = await enforceAndCatch(store);
    expect(err.code).toBe('send_limit_ip_block');
    expect(err.retryAfter).toBe(3600);
  });

  it('blocks when number-prefix cap is exhausted', async () => {
    const prefix = MOBILE.slice(0, 5);
    store.sendCountsPrefix.set(prefix, OTP_SEND_MAX_PER_PREFIX_PER_HOUR);
    const err = await enforceAndCatch(store);
    expect(err.code).toBe('send_limit_number_prefix');
  });

  it('skips anti-pumping checks for test mobiles', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR * 10);
    store.sendCountsPrefix.set(MOBILE.slice(0, 5), OTP_SEND_MAX_PER_PREFIX_PER_HOUR * 10);
    await expect(enforceSendRateLimits(store, MOBILE, IP, true)).resolves.toBeUndefined();
  });

  it('skips IP-block check when IP is null', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR * 10);
    await expect(enforceSendRateLimits(store, MOBILE, null, false)).resolves.toBeUndefined();
  });
});

describe('incrementSendCounters', () => {
  let store: InMemoryOtpSessionStore;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
  });

  it('records last-sent timestamp', async () => {
    const before = Date.now();
    await incrementSendCounters(store, MOBILE, IP, false);
    const recorded = store.lastSentAt.get(MOBILE);
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(Date.now());
  });

  it('increments 10m and day counters', async () => {
    await incrementSendCounters(store, MOBILE, IP, false);
    expect(store.sendCounts10m.get(MOBILE)).toBe(1);
    expect(store.sendCountsDay.get(MOBILE)).toBe(1);
  });

  it('increments IP-block and prefix counters for real sends', async () => {
    await incrementSendCounters(store, MOBILE, IP, false);
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBe(1);
    expect(store.sendCountsPrefix.get(MOBILE.slice(0, 5))).toBe(1);
  });

  it('does NOT increment IP-block/prefix counters for test sends', async () => {
    await incrementSendCounters(store, MOBILE, IP, true);
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBeUndefined();
    expect(store.sendCountsPrefix.get(MOBILE.slice(0, 5))).toBeUndefined();
  });

  it('accumulates counters across multiple sends', async () => {
    await incrementSendCounters(store, MOBILE, IP, false);
    await incrementSendCounters(store, MOBILE, IP, false);
    await incrementSendCounters(store, MOBILE, IP, false);
    expect(store.sendCounts10m.get(MOBILE)).toBe(3);
    expect(store.sendCountsDay.get(MOBILE)).toBe(3);
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBe(3);
  });

  it('skips IP-block increment when IP is null', async () => {
    await incrementSendCounters(store, MOBILE, null, false);
    expect(store.sendCountsIpBlock.size).toBe(0);
    expect(store.sendCounts10m.get(MOBILE)).toBe(1);
  });
});
