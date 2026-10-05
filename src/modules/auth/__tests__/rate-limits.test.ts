import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryOtpSessionStore } from '../infrastructure/testing/InMemoryOtpSessionStore.js';
import { reserveSendQuota, refundSendQuota } from '../service/rate-limits.js';
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
const PREFIX = MOBILE.slice(0, 5);

async function reserveAndCatch(
  store: InMemoryOtpSessionStore,
  isTest = false,
): Promise<RateLimitError> {
  return (await reserveSendQuota(store, MOBILE, IP, isTest).catch(
    (e: unknown) => e,
  )) as RateLimitError;
}

describe('reserveSendQuota — caps', () => {
  let store: InMemoryOtpSessionStore;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
  });

  it('allows the first send (no prior state)', async () => {
    await expect(reserveSendQuota(store, MOBILE, IP, false)).resolves.toBeUndefined();
  });

  it('blocks when cooldown has not elapsed', async () => {
    store.lastSentAt.set(MOBILE, Date.now() - 5_000);
    const err = await reserveAndCatch(store);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('send_cooldown');
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(err.retryAfter).toBeLessThanOrEqual(OTP_SEND_MIN_INTERVAL_SECONDS);
  });

  it('allows after cooldown has elapsed', async () => {
    store.lastSentAt.set(MOBILE, Date.now() - (OTP_SEND_MIN_INTERVAL_SECONDS + 5) * 1_000);
    await expect(reserveSendQuota(store, MOBILE, IP, false)).resolves.toBeUndefined();
  });

  it('blocks when 10-minute window is exhausted', async () => {
    store.sendCounts10m.set(MOBILE, OTP_SEND_MAX_PER_10M);
    const err = await reserveAndCatch(store);
    expect(err.code).toBe('send_limit_10m');
    expect(err.retryAfter).toBe(600);
  });

  it('blocks when daily limit is exhausted', async () => {
    store.sendCountsDay.set(MOBILE, OTP_SEND_MAX_PER_DAY);
    const err = await reserveAndCatch(store);
    expect(err.code).toBe('send_limit_day');
    expect(err.retryAfter).toBe(86_400);
  });

  it('blocks when IP-block cap is exhausted', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR);
    const err = await reserveAndCatch(store);
    expect(err.code).toBe('send_limit_ip_block');
    expect(err.retryAfter).toBe(3600);
  });

  it('blocks when number-prefix cap is exhausted', async () => {
    store.sendCountsPrefix.set(PREFIX, OTP_SEND_MAX_PER_PREFIX_PER_HOUR);
    const err = await reserveAndCatch(store);
    expect(err.code).toBe('send_limit_number_prefix');
  });

  it('skips anti-pumping checks AND counters for test mobiles', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR * 10);
    store.sendCountsPrefix.set(PREFIX, OTP_SEND_MAX_PER_PREFIX_PER_HOUR * 10);
    await expect(reserveSendQuota(store, MOBILE, IP, true)).resolves.toBeUndefined();
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBe(OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR * 10);
    expect(store.sendCountsPrefix.get(PREFIX)).toBe(OTP_SEND_MAX_PER_PREFIX_PER_HOUR * 10);
  });

  it('skips IP-block bucket when IP is null', async () => {
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR * 10);
    await expect(reserveSendQuota(store, MOBILE, null, false)).resolves.toBeUndefined();
  });
});

describe('reserveSendQuota — counters are consumed up front', () => {
  let store: InMemoryOtpSessionStore;

  beforeEach(() => {
    store = new InMemoryOtpSessionStore();
  });

  it('claims the cooldown and increments every bucket on success', async () => {
    const before = Date.now();
    await reserveSendQuota(store, MOBILE, IP, false);
    expect(store.lastSentAt.get(MOBILE)).toBeGreaterThanOrEqual(before);
    expect(store.sendCounts10m.get(MOBILE)).toBe(1);
    expect(store.sendCountsDay.get(MOBILE)).toBe(1);
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBe(1);
    expect(store.sendCountsPrefix.get(PREFIX)).toBe(1);
  });

  it('a rejected attempt still consumes quota (no free probing)', async () => {
    store.sendCounts10m.set(MOBILE, OTP_SEND_MAX_PER_10M);
    await reserveAndCatch(store);
    expect(store.sendCounts10m.get(MOBILE)).toBe(OTP_SEND_MAX_PER_10M + 1);
  });
});

/* ==============================================================================
 * REGRESSION — audit item #1 (SMS bombing via parallel requests)
 * Before the fix, 25 parallel requests for one number all passed.
 * ============================================================================== */
describe('reserveSendQuota — concurrency (audit #1 regression)', () => {
  it('only ONE of many parallel requests for the same number gets through', async () => {
    const store = new InMemoryOtpSessionStore();
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => reserveSendQuota(store, MOBILE, IP, false)),
    );
    const passed = results.filter(r => r.status === 'fulfilled').length;
    const cooldown = results.filter(
      r => r.status === 'rejected' && (r.reason as RateLimitError).code === 'send_cooldown',
    ).length;
    expect(passed).toBe(1);
    expect(cooldown).toBe(49);
  });

  it('parallel requests across many numbers never exceed the IP-block cap', async () => {
    const store = new InMemoryOtpSessionStore();
    store.sendCountsIpBlock.set(IP_KEY, OTP_SEND_MAX_PER_IPBLOCK_PER_HOUR - 3);
    // 40 different numbers (distinct cooldown buckets) from one subnet.
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        reserveSendQuota(store, `9198${String(10_000_000 + i)}`, IP, false),
      ),
    );
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(3);
  });
});

describe('refundSendQuota', () => {
  it('releases the cooldown and gives back one unit of per-mobile counters', async () => {
    const store = new InMemoryOtpSessionStore();
    await reserveSendQuota(store, MOBILE, IP, false);
    await refundSendQuota(store, MOBILE);
    expect(store.lastSentAt.has(MOBILE)).toBe(false);
    expect(store.sendCounts10m.get(MOBILE)).toBe(0);
    expect(store.sendCountsDay.get(MOBILE)).toBe(0);
    // user can retry immediately
    await expect(reserveSendQuota(store, MOBILE, IP, false)).resolves.toBeUndefined();
  });

  it('does NOT refund anti-pumping buckets', async () => {
    const store = new InMemoryOtpSessionStore();
    await reserveSendQuota(store, MOBILE, IP, false);
    await refundSendQuota(store, MOBILE);
    expect(store.sendCountsIpBlock.get(IP_KEY)).toBe(1);
    expect(store.sendCountsPrefix.get(PREFIX)).toBe(1);
  });

  it('never drives a counter below zero', async () => {
    const store = new InMemoryOtpSessionStore();
    await refundSendQuota(store, MOBILE);
    expect(store.sendCounts10m.get(MOBILE) ?? 0).toBe(0);
  });
});
