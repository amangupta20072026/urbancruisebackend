/**
 * X-Request-Id validation — audit item #16.
 */
import { describe, it, expect } from 'vitest';
import { resolveRequestId } from '../request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId (audit #16 regression)', () => {
  it.each([
    'c0ffee00-1234-4abc-8def-0123456789ab', // UUID
    'a1b2c3d4e5f60718293a4b5c6d7e8f90', // nginx $request_id
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // W3C traceparent
    'req.abc:123_x',
  ])('keeps a safe id: %s', id => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([
    ['newline log injection', 'abc\n{"level":"info","msg":"admin login ok"}'],
    ['quotes / JSON', 'x","userId":"1'],
    ['spaces', 'a b'],
    ['too long (129 chars)', 'a'.repeat(129)],
    ['empty', ''],
    ['comma-joined duplicate header', 'id1, id2'],
  ])('replaces unsafe input (%s) with a fresh UUID', (_label, bad) => {
    const out = resolveRequestId(bad);
    expect(out).not.toBe(bad);
    expect(out).toMatch(UUID);
  });

  it.each([undefined, null, 42, ['a', 'b']])('non-string %j → fresh UUID', v => {
    expect(resolveRequestId(v)).toMatch(UUID);
  });
});
