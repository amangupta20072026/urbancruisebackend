/**
 * MSG91 delivery-report (DLR) webhook helpers. MSG91 does not sign these
 * requests, so the URL carries a secret instead:
 *   /webhooks/msg91/<MSG91_WEBHOOK_SECRET>/delivery
 * To rotate: change MSG91_WEBHOOK_SECRET and update the URL in MSG91.
 */
import { timingSafeEqual } from 'node:crypto';
import { ENV } from '../../../config/env.js';

/** Constant-time check of the URL token against MSG91_WEBHOOK_SECRET. */
export function verifyWebhookToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = ENV.MSG91_WEBHOOK_SECRET;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One delivery record. A single push can contain many. */
export type NormalisedDlr = {
  /** MSG91 request id saved at send time. */
  providerRequestId: string;
  /** Recipient, as sent by MSG91 (e.g. '919812345678'). */
  mobile: string;
  status: 'delivered' | 'failed' | 'rejected';
  /** Carrier reason text from MSG91. */
  description: string | null;
  /** MSG91 numeric status code. */
  providerStatusCode: number | null;
};

/**
 * Normalises any DLR body MSG91 sends: a form body with a JSON `data` string,
 * a flat record { reqid, status, desc, number }, a grouped record
 * { requestId, numbers: { <mobile>: { status, desc } } }, or arrays of these.
 * Returns [] for anything unrecognised.
 */
export function parseDlrPayload(raw: unknown): NormalisedDlr[] {
  if (raw === null || raw === undefined) return [];

  // Form body: { data: "<json string>" }
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

  if (Array.isArray(raw)) {
    const out: NormalisedDlr[] = [];
    for (const item of raw) {
      out.push(...parseDlrPayload(item));
    }
    return out;
  }

  if (typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  // Grouped record
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

  // Flat record
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
 * MSG91 status → final status: 1 delivered, 2 failed, 16 rejected.
 * Other codes are not final and are skipped.
 */
function mapStatus(code: number | null): 'delivered' | 'failed' | 'rejected' | null {
  if (code === 1) return 'delivered';
  if (code === 2) return 'failed';
  if (code === 16) return 'rejected';
  return null;
}
