/**
 * ==============================================================================
 * resolveRequestId — accept a caller's X-Request-Id only if it is safe
 * ==============================================================================
 * The request id is echoed back in the X-Request-Id response header,
 * written into EVERY log line for the request, and returned in every error
 * envelope. It used to be taken from the client verbatim — any length, any
 * characters (audit fix #16). That allowed:
 *   • log injection / forging — newlines, quotes or JSON fragments in a
 *     field operators grep and trust;
 *   • log bloat — multi-kilobyte ids copied into every line of a request;
 *   • correlation spoofing — an attacker reusing a victim's id so their
 *     requests interleave with the victim's in support searches.
 *
 * Accepted: 1–128 chars of [A-Za-z0-9._:-] — covers UUIDs, nginx's
 * $request_id (32 hex), and W3C/Datadog-style trace ids, so end-to-end
 * tracing through the proxy keeps working. Anything else → fresh UUID.
 * Used by BOTH the requestId middleware and pino-http's genReqId so the
 * two can never disagree.
 * ==============================================================================
 */
import { randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}
