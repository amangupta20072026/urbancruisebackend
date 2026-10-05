/**
 * HTTP-level regressions — audit items #15 (body limits / body-parser errors)
 * and #16 (request id), exercised through real Express middleware.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestId } from '../middleware/requestId.js';
import { JSON_BODY_LIMIT } from '../../../config/constants.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.post('/echo', (req, res) => res.json({ got: req.body }));
  app.use(errorHandler);
  await new Promise<void>(r => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

describe('body parsing (audit #15 regression)', () => {
  it('malformed JSON → 400 INVALID_JSON (was: 500 SERVER_ERROR)', async () => {
    const r = await post('{"phone":');
    expect(r.status).toBe(400);
    const b = (await r.json()) as { error: { code: string; requestId: string } };
    expect(b.error.code).toBe('INVALID_JSON');
    expect(b.error.requestId).toBeTruthy();
  });

  it('body over 100 KB → 413 PAYLOAD_TOO_LARGE (was: parsed up to 10 MB)', async () => {
    const r = await post(JSON.stringify({ pad: 'x'.repeat(150_000) }));
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('a normal-sized body still works', async () => {
    const r = await post(JSON.stringify({ phone: '9812345678' }));
    expect(r.status).toBe(200);
  });
});

describe('X-Request-Id handling (audit #16 regression)', () => {
  it('a safe inbound id is kept and echoed', async () => {
    const r = await post('{}', { 'x-request-id': 'trace-abc-123' });
    expect(r.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('an oversized inbound id is replaced, not echoed', async () => {
    const big = 'a'.repeat(5000);
    const r = await post('{}', { 'x-request-id': big });
    expect(r.headers.get('x-request-id')).not.toBe(big);
    expect(r.headers.get('x-request-id')!.length).toBe(36);
  });

  it('an id with JSON/quote characters is replaced', async () => {
    const r = await post('{', { 'x-request-id': 'x","admin":"true' });
    const b = (await r.json()) as { error: { requestId: string } };
    expect(b.error.requestId).not.toContain('admin');
  });
});
