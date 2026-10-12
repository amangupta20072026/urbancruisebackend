/** customer.payments controller. */
import type { Request, Response } from 'express';
import { asyncHandler } from '../../../shared/http/asyncHandler.js';
import { getIdentity } from '../../../shared/http/responses.js';
import { generateReceipt } from './service.js';

/** GET /payments/:id/receipt — sends the receipt PDF as a download. */
export const getPaymentReceipt = asyncHandler(async (req: Request, res: Response) => {
  const identity = getIdentity(req);
  const { id } = req.params as { id: string };

  const { buffer, filename } = await generateReceipt(id, identity);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader('Content-Length', buffer.length);
  // Receipts are personal: never cache.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).end(buffer);
});
