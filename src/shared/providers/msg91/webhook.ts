/**
 * ==============================================================================
 * MSG91 delivery-report (DLR) webhook — payload parsing + URL-token check
 * ==============================================================================
 * MSG91 does NOT sign DLR pushes with an HMAC / signature header — this is
 * confirmed by their official docs (api.msg91.com/apidoc/textsms/delivery-
 * report.php and the "Push DLR" KB pages). Their portal simply POSTs to
 * whatever URL you configure. There is no `x-msg91-signature` header.
 *
 * The practical, provider-agnostic pattern for callbacks-without-signatures
 * is to embed a shared secret in the webhook URL path itself:
 *
 *     https://api.example.com/webhooks/msg91/<SECRET_TOKEN>/delivery
 *
 * You give this URL only to MSG91's dashboard. Because the URL is a secret,
 * possession of it authenticates the caller. Rotate by generating a new
 * MSG91_WEBHOOK_SECRET and updating the URL in the MSG91 portal.
 *
 * NOTE ON PAYLOAD SHAPES:
 * MSG91 has historically used two DLR shapes across their SMS products:
 *
 *   (A) Legacy "sendhttp" / classic DLR push — flat body, per record:
 *         { reqid, status, desc, number, date }
 *       where status is numeric: 1=delivered, 2=failed, 16=rejected
 *
 *   (B) Flow / v5 DLR push — JSON array of objects:
 *         [{ requestId, numbers: { "919812345678": { status, desc, ... } } }]
 *
 * We accept both, plus a bare array-of-flat-records case, so the same
 * endpoint works regardless of which product family the send used. Any
 * unrecognised shape is logged (never crashes) and the endpoint returns
 * 200 so MSG91 doesn't retry forever.
 *
 * MSG91 status code mapping (per their delivery-report API doc):
 *   1  → delivered
 *   2  → failed (transient — subscriber absent, out of coverage, etc.)
 *   16 → rejected (permanent — DND, invalid number, template block)
 * ==============================================================================
 */
import { timingSafeEqual } from 'node:crypto';
import { ENV } from '../../../config/env.js';

/**
 * Timing-safe compare of a candidate token against the configured secret.
 * Used by the route to verify the `:token` URL param.
 */
export function verifyWebhookToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = ENV.MSG91_WEBHOOK_SECRET;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ==============================================================================
 * DLR payload parsing
 * ============================================================================== */

/**
 * Internal per-record shape after normalisation. One MSG91 push may contain
 * many of these (batch). Everything downstream (repo update, logging) works
 * off this shape only — the raw MSG91 payload never leaks past this file.
 */
export type NormalisedDlr = {
  /** MSG91 request id we recorded at send time (msg91_request_id column). */
  providerRequestId: string;
  /** Recipient E.164-without-plus (as MSG91 sends it). */
  mobile: string;
  /** Bucketed final status. */
  status: 'delivered' | 'failed' | 'rejected';
  /** Free-text carrier reason from MSG91 (e.g. "ABSENT SUBSCRIBER", "DND Failure"). */
  description: string | null;
  /** Raw numeric status code MSG91 sent (1|2|16 typically). */
  providerStatusCode: number | null;
};

/**
 * Parse whatever MSG91 sent — body may already be a JSON object/array, or a
 * URL-encoded form body carrying a `data` field whose value is a JSON string
 * (the legacy shape). Returns [] for anything unrecognised so the route can
 * 200-OK without persisting garbage.
 */
export function parseDlrPayload(raw: unknown): NormalisedDlr[] {
  if (raw === null || raw === undefined) return [];

  // Legacy transport: form-encoded { data: "<json-string>" }
  if (typeof raw === 'object' && !Array.isArray(raw) && 'data' in raw) {
    const inner = (raw as { data: unknown }).data;
    if (typeof inner === 'string') {
      try {
        return parseDlrPayload(JSON.parse(inner));
      } catch {
        return [];
      }
    }
    return parseDlrPayload(inner);
  }

  // Array — may be array of flat records (shape A) or array of grouped
  // records (shape B). Flatten either way.
  if (Array.isArray(raw)) {
    const out: NormalisedDlr[] = [];
    for (const item of raw) {
      out.push(...parseDlrPayload(item));
    }
    return out;
  }

  if (typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // Shape B: { requestId, numbers: { "<mobile>": { status, desc } } }
  if ('numbers' in obj && typeof obj['numbers'] === 'object' && obj['numbers'] !== null) {
    const requestId = readString(obj['requestId']) ?? readString(obj['reqid']);
    if (!requestId) return [];
    const numbers = obj['numbers'] as Record<string, unknown>;
    const out: NormalisedDlr[] = [];
    for (const [mobile, entry] of Object.entries(numbers)) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const code = readNumber(e['status']);
      const status = mapStatus(code);
      if (!status) continue;
      out.push({
        providerRequestId: requestId,
        mobile,
        status,
        description: readString(e['desc']) ?? readString(e['description']) ?? null,
        providerStatusCode: code,
      });
    }
    return out;
  }

  // Shape A: flat { reqid, status, desc, number, date }
  const requestId = readString(obj['reqid']) ?? readString(obj['requestId']);
  const mobile = readString(obj['number']) ?? readString(obj['mobile']);
  const code = readNumber(obj['status']);
  const status = mapStatus(code);
  if (!requestId || !mobile || !status) return [];
  return [
    {
      providerRequestId: requestId,
      mobile,
      status,
      description: readString(obj['desc']) ?? readString(obj['description']) ?? null,
      providerStatusCode: code,
    },
  ];
}

/* -----------------------------------------------------------------
 * Local helpers
 * ----------------------------------------------------------------- */

function readString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Bucket the MSG91 numeric code. Per their delivery-report API doc:
 *   1  = delivered
 *   2  = failed (transient / carrier-reported failure)
 *   16 = rejected (DLT / DND / permanent block)
 * Anything else is treated as an intermediate/unknown status and skipped —
 * we only want to persist terminal states.
 */
function mapStatus(code: number | null): 'delivered' | 'failed' | 'rejected' | null {
  if (code === 1) return 'delivered';
  if (code === 2) return 'failed';
  if (code === 16) return 'rejected';
  return null;
}
