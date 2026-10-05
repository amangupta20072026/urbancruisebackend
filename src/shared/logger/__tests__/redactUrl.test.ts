import { describe, it, expect } from 'vitest';
import { redactUrl } from '../redactUrl.js';

const SECRET = 'SUPER-SECRET-WEBHOOK-TOKEN-0123456789abcdef';

describe('redactUrl (audit #3 regression)', () => {
  it('redacts the MSG91 webhook token', () => {
    expect(redactUrl(`/webhooks/msg91/${SECRET}/delivery`)).toBe(
      '/webhooks/msg91/[REDACTED]/delivery',
    );
  });

  it('redacts when there is no trailing segment, or a query string', () => {
    expect(redactUrl(`/webhooks/msg91/${SECRET}`)).toBe('/webhooks/msg91/[REDACTED]');
    expect(redactUrl(`/webhooks/msg91/${SECRET}?x=1`)).toBe('/webhooks/msg91/[REDACTED]?x=1');
  });

  it('is case-insensitive and tolerates repeated slashes (Express routes these)', () => {
    expect(redactUrl(`/WEBHOOKS/MSG91/${SECRET}/delivery`)).not.toContain(SECRET);
    expect(redactUrl(`//webhooks//msg91//${SECRET}/delivery`)).not.toContain(SECRET);
  });

  it('leaves every other URL untouched', () => {
    expect(redactUrl('/api/v1/auth/otp/request')).toBe('/api/v1/auth/otp/request');
    expect(redactUrl('/health')).toBe('/health');
    expect(redactUrl(undefined)).toBeUndefined();
  });

  it('is stable across repeated calls (no global-regex lastIndex bug)', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(redactUrl(`/webhooks/msg91/${SECRET}/delivery`)).not.toContain(SECRET);
    }
  });
});
