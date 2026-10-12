/**
 * Maps MSG91 responses to a small set of outcomes. MSG91 reports errors both
 * as non-2xx statuses and as `type: 'error'` in a 200 body; both are handled
 * here, so only this file changes if MSG91's codes change.
 */
import type { AxiosError, AxiosResponse } from 'axios';

/** Send outcome. Only timeout, network and provider_server_error are retried. */
export type ProviderOutcome =
  | 'success'
  | 'wallet_low' // 402: no MSG91 credit
  | 'template_bad' // template id or variables rejected
  | 'provider_forbidden' // 403: bad auth key or route disabled
  | 'rate_limited' // 429 from MSG91
  | 'provider_server_error' // 5xx
  | 'timeout'
  | 'network' // no response
  | 'unknown'; // anything else

export type ProviderResult = {
  outcome: ProviderOutcome;
  requestId?: string;
  raw?: unknown;
  errorCode?: string;
  errorMessage?: string;
};

/** MSG91 body; every field is optional. */
type Msg91Body = {
  type?: unknown;
  message?: unknown;
  error?: unknown;
  code?: unknown;
  errors?: unknown;
  data?: unknown;
};

/**
 * Parses a 2xx response (which can still contain `type: 'error'`). On
 * success, `message` holds MSG91's request id, used to match webhooks.
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

  if (code && /template/i.test(errMsg)) {
    return build('template_bad', errMsg, code, body);
  }
  return build('unknown', errMsg, code, body);
}

/** Parses an axios error (non-2xx or no response). */
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
