/**
 * ==============================================================================
 * auth.webhook — MSG91 DLR receiver
 * ==============================================================================
 * POST /webhooks/msg91/:token/delivery
 *
 * MSG91 posts a delivery report to this URL after each SMS reaches (or fails
 * to reach) the handset. The `:token` in the path is a shared secret; only
 * MSG91's portal knows the URL, so possession authenticates the caller.
 *
 * WHY THIS ENDPOINT ALWAYS RETURNS 200 (except for wrong token):
 *   MSG91 retries any non-2xx response — for hours. If we 4xx a payload
 *   whose shape we don't recognise, or 5xx on a transient DB blip, MSG91
 *   floods us with retries and the queue backs up. Instead we log-and-ack:
 *   parse defensively, apply what we understood, always 200. Auditors read
 *   the logs; MSG91 keeps moving.
 *
 * A wrong `:token` DOES return 401 — that is not MSG91 talking to us, it is
 * an attacker probing. No retry storm concern.
 * ==============================================================================
 */
import type { Request, Response } from 'express';
import { logger } from '../../../shared/logger/index.js';
import { verifyWebhookToken, parseDlrPayload } from '../../../shared/providers/msg91/webhook.js';
import { applyDlr } from '../repository.js';

type TokenParams = { token: string };

export async function postMsg91Dlr(req: Request<TokenParams>, res: Response): Promise<Response> {
  // 1. Authenticate via URL-embedded shared secret (timing-safe compare).
  if (!verifyWebhookToken(req.params.token)) {
    logger.warn(
      { ip: req.ip, ua: req.header('user-agent') },
      'msg91 DLR webhook: rejected — bad token',
    );
    return res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'invalid webhook token' } });
  }

  // 2. Parse whatever shape MSG91 sent. `req.body` may be a JSON object,
  //    a JSON array, or an object with a `data` field carrying a JSON
  //    string (legacy shape). parseDlrPayload handles all three.
  const records = parseDlrPayload(req.body);

  if (records.length === 0) {
    // Unrecognised shape — log the raw body for investigation and ack. Do
    // NOT include the full body in production logs at info level; MSG91
    // DLRs can contain phone numbers. Truncate + warn.
    logger.warn(
      { bodyKeys: safeKeys(req.body) },
      'msg91 DLR webhook: 0 records parsed from payload',
    );
    return res.status(200).json({ ok: true, applied: 0 });
  }

  // 3. Apply each DLR to its otp_events row. Errors on a single row must
  //    NOT prevent processing of the others in the same push.
  let applied = 0;
  let skipped = 0;
  let errored = 0;

  for (const rec of records) {
    try {
      const rows = await applyDlr({
        msg91RequestId: rec.providerRequestId,
        dlr: rec.status,
        description: rec.description,
        providerStatusCode: rec.providerStatusCode,
      });
      if (rows === 1) {
        applied += 1;
      } else {
        // 0 rows means either: unknown request id (send-row was never
        // written; test-mobile paths bypass MSG91 entirely) OR row is
        // already in a terminal state (duplicate/late DLR — idempotent
        // no-op). Both are safe.
        skipped += 1;
      }
    } catch (err) {
      errored += 1;
      logger.error(
        { err, providerRequestId: rec.providerRequestId },
        'msg91 DLR webhook: DB update failed',
      );
    }
  }

  // 4. Surface an operator-friendly summary. Aggregate a `failed` count too
  //    so a monitoring rule ("failed:applied ratio spikes") can page.
  const summary = countByStatus(records);
  logger.info(
    { received: records.length, applied, skipped, errored, ...summary },
    'msg91 DLR webhook: processed batch',
  );

  return res.status(200).json({ ok: true, received: records.length, applied, skipped });
}

/* -----------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------- */

function safeKeys(v: unknown): string[] {
  if (v === null || typeof v !== 'object') return [];
  return Object.keys(v as Record<string, unknown>).slice(0, 20);
}

function countByStatus(records: ReturnType<typeof parseDlrPayload>): {
  delivered: number;
  failed: number;
  rejected: number;
} {
  let delivered = 0;
  let failed = 0;
  let rejected = 0;
  for (const r of records) {
    if (r.status === 'delivered') delivered += 1;
    else if (r.status === 'failed') failed += 1;
    else if (r.status === 'rejected') rejected += 1;
  }
  return { delivered, failed, rejected };
}
