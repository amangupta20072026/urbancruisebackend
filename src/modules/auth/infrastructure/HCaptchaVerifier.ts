/**
 * ICaptchaVerifier using hCaptcha siteverify. Sends the secret, token,
 * client IP and (optionally) the site key. hCaptcha rejects replayed tokens.
 * Never throws: timeouts, network errors and bad replies return
 * 'unavailable', and sendOtp then fails closed.
 */
import axios from 'axios';
import type { CaptchaVerdict, ICaptchaVerifier } from '../ports/ICaptchaVerifier.js';

const SITEVERIFY_URL = 'https://api.hcaptcha.com/siteverify';
const TIMEOUT_MS = 5_000;

/** HTTP seam so tests can run without the network. */
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

/** Used when HCAPTCHA_SECRET is not set (gate off). */
export class DisabledCaptchaVerifier implements ICaptchaVerifier {
  readonly enabled = false;

  async verify(): Promise<CaptchaVerdict> {
    // Unreachable: sendOtp checks `enabled` first.
    return { ok: true };
  }
}
