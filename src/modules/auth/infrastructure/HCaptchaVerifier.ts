/**
 * ==============================================================================
 * HCaptchaVerifier — ICaptchaVerifier backed by hCaptcha siteverify
 * ==============================================================================
 * API: POST https://api.hcaptcha.com/siteverify  (application/x-www-form-urlencoded)
 *   secret    — HCAPTCHA_SECRET
 *   response  — the token the app obtained from the hCaptcha widget
 *   remoteip  — optional, the client IP
 *   sitekey   — optional; when sent, tokens for any other site key fail
 * Reply: { success: boolean, "error-codes"?: string[], ... }
 * Tokens are single-use: hCaptcha itself rejects a replayed token.
 *
 * Never throws. A timeout / network error / malformed reply is reported as
 * `unavailable`, and the caller decides (sendOtp fails CLOSED — see there).
 * ==============================================================================
 */
import axios from 'axios';
import type { CaptchaVerdict, ICaptchaVerifier } from '../ports/ICaptchaVerifier.js';

const SITEVERIFY_URL = 'https://api.hcaptcha.com/siteverify';
const TIMEOUT_MS = 5_000;

/** Minimal HTTP seam so the class is unit-testable without network access. */
export type FormPoster = (url: string, form: URLSearchParams) => Promise<unknown>;

const axiosPoster: FormPoster = async (url, form) => {
  const res = await axios.post(url, form, {
    timeout: TIMEOUT_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return res.data;
};

export class HCaptchaVerifier implements ICaptchaVerifier {
  readonly enabled = true;

  constructor(
    private readonly secret: string,
    private readonly siteKey: string | null = null,
    private readonly post: FormPoster = axiosPoster,
  ) {}

  async verify(token: string, remoteIp: string | null): Promise<CaptchaVerdict> {
    const form = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) form.set('remoteip', remoteIp);
    if (this.siteKey) form.set('sitekey', this.siteKey);

    let body: unknown;
    try {
      body = await this.post(SITEVERIFY_URL, form);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }

    if (body === null || typeof body !== 'object' || !('success' in body)) {
      return { ok: false, reason: 'unavailable' };
    }
    const b = body as { success: unknown; 'error-codes'?: unknown };
    if (b.success === true) return { ok: true };
    const codes = Array.isArray(b['error-codes'])
      ? b['error-codes'].filter((c): c is string => typeof c === 'string')
      : [];
    return { ok: false, reason: 'invalid', providerCodes: codes };
  }
}

/** Gate OFF — used when HCAPTCHA_SECRET is not configured. */
export class DisabledCaptchaVerifier implements ICaptchaVerifier {
  readonly enabled = false;

  async verify(): Promise<CaptchaVerdict> {
    // Never consulted while disabled (sendOtp checks `enabled` first).
    return { ok: true };
  }
}
