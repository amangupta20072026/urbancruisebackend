/**
 * MSG91 delivery-report (DLR) receiver.
 * Always answers 200 once the token is valid: MSG91 retries any non-2xx for
 * hours, so unknown shapes and DB errors are logged, not rejected.
 * A wrong token gets 401; that's a probe, not MSG91.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../shared/logger/index.js';
import { verifyWebhookToken, parseDlrPayload } from '../../../shared/providers/msg91/webhook.js';
import { authDeps } from '../infrastructure/AuthContainer.js';

type TokenParams = { token: string };

/** Checks the URL token (timing-safe). Runs before body parsing. */
export function requireMsg91Token(
  req: Request<TokenParams>,
  res: Response,
  next: NextFunction,
): void {
  if (!verifyWebhookToken(req.params.token)) {
    logger.warn(
      { ip: req.ip, ua: req.header('user-agent') },
      'msg91 DLR webhook: rejected — bad token',
    );
    res.status(401).json({ error: { code: 'BAD_TOKEN', message: 'invalid webhook token' } });
    return;
  }
  next();
}

/** Applies each delivery report to its otp_events row. */
export async function postMsg91Dlr(req: Request<TokenParams>, res: Response): Promise<Response> {
  const records = parseDlrPayload(req.body);

  if (records.length === 0) {
    logger.warn(
      { bodyKeys: safeKeys(req.body) },
      'msg91 DLR webhook: 0 records parsed from payload',
    );
    return res.status(200).json({ ok: true, applied: 0 });
  }

  // One failing row must not block the rest.
  let applied = 0;
  let skipped = 0;
  let errored = 0;

  for (const rec of records) {
    try {
      const rows = await authDeps.repo.applyDlr({
        msg91RequestId: rec.providerRequestId,
        dlr: rec.status,
        description: rec.description,
        providerStatusCode: rec.providerStatusCode,
      });
      if (rows === 1) {
        applied += 1;
      } else {
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

  const summary = countByStatus(records);
  logger.info(
    { received: records.length, applied, skipped, errored, ...summary },
    'msg91 DLR webhook: processed batch',
  );

  return res.status(200).json({ ok: true, received: records.length, applied, skipped });
}

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
