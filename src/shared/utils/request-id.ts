/**
 * Reuses the client's X-Request-Id only if it is 1–128 chars of
 * [A-Za-z0-9._:-] (UUIDs, Nginx $request_id, trace ids); otherwise makes a
 * new UUID. Unsafe ids could inject or bloat log lines.
 */
import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}
