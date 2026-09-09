/**
 * ==============================================================================
 * MSG91 delivery-webhook signature verification
 * ==============================================================================
 * MSG91 posts delivery updates to /webhooks/msg91/delivery. Signature is an
 * HMAC-SHA256 of the raw body using our MSG91_WEBHOOK_SECRET, sent in the
 * `x-msg91-signature` header.
 *
 * The route registers `express.raw({ type: 'application/json' })` for THIS
 * path only (mirroring app.js's Razorpay webhook pattern). We need the raw
 * bytes to compute HMAC — parsed JSON changes byte-for-byte.
 *
 * INSECURE FALLBACK (dev only): when MSG91_WEBHOOK_SECRET is set to
 * 'dev-skip-verify', signature verification is bypassed. Never use in prod
 * — the env schema rejects strings shorter than 16 chars, so a real prod
 * secret can't accidentally hit this branch.
 * ==============================================================================
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ENV } from '../../../config/env.js';

const HEADER_SIGNATURE = 'x-msg91-signature';

/**
 * @param rawBody the raw request body (Buffer)
 * @param signatureHeader value of the x-msg91-signature header
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (ENV.MSG91_WEBHOOK_SECRET === 'dev-skip-verify') return true;
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', ENV.MSG91_WEBHOOK_SECRET).update(rawBody).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export { HEADER_SIGNATURE };
