/**
 * ==============================================================================
 * MSG91 error normalization
 * ==============================================================================
 * MSG91 mixes HTTP status codes with WhatsApp-specific error codes in the
 * response body. This file collapses BOTH into a small set of internal
 * outcomes the service layer can pattern-match on.
 *
 * If MSG91 changes their codes, ONLY this file needs to update.
 * ==============================================================================
 */
import type { AxiosError, AxiosResponse } from 'axios';

export type Msg91Outcome =
  | 'success'
  | 'phone_not_wa'
  | 'user_blocked'
  | 'wallet_low'
  | 'template_bad'
  | 'waba_suspended'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'unknown';

export type Msg91Result = {
  outcome: Msg91Outcome;
  requestId?: string;
  raw?: unknown;
  errorCode?: string;
  errorMessage?: string;
};

/** Loose shape of MSG91 body — every field optional; we probe via safe reads. */
type Msg91Body = {
  type?: unknown;
  message?: unknown;
  error?: unknown;
  code?: unknown;
  errors?: unknown;
  data?: unknown;
};

const META_PHONE_NOT_WHATSAPP = '131026';
const META_USER_BLOCKED_CODES = new Set(['131048', '131049', '131050']);

/**
 * Parse a SUCCESSFUL axios response body (2xx). MSG91 may still return
 * `type: 'error'` inside a 200 body — check the body flag, not just status.
 */
export function parseMsg91Response(res: AxiosResponse): Msg91Result {
  const body = (res.data ?? {}) as Msg91Body;

  const type = String(body.type ?? '').toLowerCase();
  const message = body.message !== undefined ? String(body.message) : undefined;

  if (type === 'success') {
    const out: Msg91Result = { outcome: 'success', raw: body };
    if (message) out.requestId = message;
    return out;
  }

  const code = extractErrorCode(body);
  const errMsg = String(body.message ?? body.error ?? 'MSG91 error');

  if (code === META_PHONE_NOT_WHATSAPP) {
    return build('phone_not_wa', errMsg, code, body);
  }
  if (code && META_USER_BLOCKED_CODES.has(code)) {
    return build('user_blocked', errMsg, code, body);
  }

  return build('unknown', errMsg, code, body);
}

/**
 * Parse an axios ERROR (non-2xx or transport-level). Maps HTTP status to
 * the internal outcome set.
 */
export function parseMsg91Error(err: unknown): Msg91Result {
  const ax = err as AxiosError;

  if (ax?.code === 'ECONNABORTED' || /timeout/i.test(ax?.message ?? '')) {
    return { outcome: 'timeout', errorMessage: ax.message };
  }
  if (!ax?.response) {
    return { outcome: 'network', errorMessage: ax?.message ?? 'no response' };
  }

  const status = ax.response.status;
  const body = (ax.response.data ?? {}) as Msg91Body;
  const code = extractErrorCode(body);
  const errMsg = String(body.message ?? ax.message ?? `HTTP ${status}`);

  switch (status) {
    case 402:
      return build('wallet_low', errMsg, code, body);
    case 403:
      return build('waba_suspended', errMsg, code, body);
    case 429:
      return build('rate_limited', errMsg, code, body);
    case 400:
      if (code && /template/i.test(errMsg)) return build('template_bad', errMsg, code, body);
      return build('unknown', errMsg, code, body);
    default:
      return build('unknown', errMsg, code, body);
  }
}

function build(
  outcome: Msg91Outcome,
  errMsg: string,
  code: string | undefined,
  raw: unknown,
): Msg91Result {
  const r: Msg91Result = { outcome, errorMessage: errMsg, raw };
  if (code) r.errorCode = code;
  return r;
}

function extractErrorCode(body: Msg91Body): string | undefined {
  if (body.code !== undefined) return String(body.code);
  const errs = body.errors;
  if (Array.isArray(errs) && errs[0] && typeof errs[0] === 'object') {
    const first = errs[0] as { code?: unknown };
    if (first.code !== undefined) return String(first.code);
  }
  if (typeof body.data === 'object' && body.data !== null) {
    const inner = body.data as { code?: unknown };
    if (inner.code !== undefined) return String(inner.code);
  }
  return undefined;
}
