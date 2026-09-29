/**
 * ==============================================================================
 * MSG91 error normalization (SMS-only)
 * ==============================================================================
 * MSG91 sometimes returns `type: 'error'` inside a 200 body and sometimes uses
 * regular non-2xx HTTP status codes. This file collapses BOTH into a small set
 * of channel-neutral internal outcomes the service layer can pattern-match on.
 *
 * When email OTP lands as a second channel, its provider adapter should map
 * into the SAME `ProviderOutcome` set so downstream logic (retry, audit, error
 * surfacing) stays uniform.
 *
 * If MSG91 changes their codes, ONLY this file needs to update.
 *
 * References (official):
 *   • Send SMS via Flow (v5): https://api.msg91.com/apidoc/textsms/send-sms-flow.php
 *   • MSG91 error code index: https://msg91.com/help
 * ==============================================================================
 */
import type { AxiosError, AxiosResponse } from 'axios';

/**
 * Channel-neutral send outcome. Kept small on purpose — downstream code
 * pattern-matches on these, not on raw HTTP codes or provider strings.
 *
 * TRANSIENT outcomes (safe to retry inside dispatchOtp):
 *   - timeout, network, provider_server_error
 *
 * NON-TRANSIENT outcomes (retrying makes it worse or wastes money):
 *   - wallet_low, template_bad, provider_forbidden, rate_limited, unknown
 */
export type ProviderOutcome =
  | 'success'
  | 'wallet_low' // provider account has no credit — surface as 503, do not retry
  | 'template_bad' // template id / variables rejected — surface, do not retry
  | 'provider_forbidden' // 403 — auth key invalid / route disabled — surface
  | 'rate_limited' // provider-side rate limit hit — surface, do not retry
  | 'provider_server_error' // 5xx — transient provider outage — retry once
  | 'timeout' // network timeout — retry once
  | 'network' // no response at all — retry once
  | 'unknown'; // any other 4xx we cannot classify — do not retry

/**
 * @deprecated Kept as an alias while callers migrate to `ProviderOutcome`.
 * Remove once no imports of `Msg91Outcome` remain.
 */
export type Msg91Outcome = ProviderOutcome;

export type ProviderResult = {
  outcome: ProviderOutcome;
  requestId?: string;
  raw?: unknown;
  errorCode?: string;
  errorMessage?: string;
};

/** @deprecated alias — see ProviderOutcome. */
export type Msg91Result = ProviderResult;

/** Loose shape of MSG91 body — every field optional; we probe via safe reads. */
type Msg91Body = {
  type?: unknown;
  message?: unknown;
  error?: unknown;
  code?: unknown;
  errors?: unknown;
  data?: unknown;
};

/**
 * Parse a SUCCESSFUL axios response body (2xx). MSG91 may still return
 * `type: 'error'` inside a 200 body — check the body flag, not just status.
 *
 * On success, MSG91's Flow API echoes the provider request-id in `message`;
 * we surface it so the webhook can be correlated later.
 */
export function parseMsg91Response(res: AxiosResponse): ProviderResult {
  const body = (res.data ?? {}) as Msg91Body;

  const type = String(body.type ?? '').toLowerCase();
  const message = body.message !== undefined ? String(body.message) : undefined;

  if (type === 'success') {
    const out: ProviderResult = { outcome: 'success', raw: body };
    if (message) out.requestId = message;
    return out;
  }

  const code = extractErrorCode(body);
  const errMsg = String(body.message ?? body.error ?? 'MSG91 error');

  // 200 with type='error' — classify by message/code where we can, otherwise unknown.
  if (code && /template/i.test(errMsg)) {
    return build('template_bad', errMsg, code, body);
  }
  return build('unknown', errMsg, code, body);
}

/**
 * Parse an axios ERROR (non-2xx or transport-level). Maps HTTP status to
 * the internal outcome set.
 */
export function parseMsg91Error(err: unknown): ProviderResult {
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
      return build('provider_forbidden', errMsg, code, body);
    case 429:
      return build('rate_limited', errMsg, code, body);
    case 400:
      if (code && /template/i.test(errMsg)) return build('template_bad', errMsg, code, body);
      return build('unknown', errMsg, code, body);
    default:
      // 5xx from MSG91 — transient provider outage. Distinguished from
      // 'unknown' (which is 4xx we can't classify) because 5xx is safe to
      // retry once whereas a mystery 4xx probably isn't.
      if (status >= 500 && status <= 599) {
        return build('provider_server_error', errMsg, code, body);
      }
      return build('unknown', errMsg, code, body);
  }
}

function build(
  outcome: ProviderOutcome,
  errMsg: string,
  code: string | undefined,
  raw: unknown,
): ProviderResult {
  const r: ProviderResult = { outcome, errorMessage: errMsg, raw };
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
