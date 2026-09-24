/**
 * customer.payments — controller
 * HTTP-layer only. Parses validated req, calls service, streams PDF.
 */
import type { Request, Response } from 'express';
import { asyncHandler } from '../../../shared/http/asyncHandler.js';
import { getIdentity } from '../../../shared/http/responses.js';
import { generateReceipt } from './service.js';

/**
 * GET /api/v1/customer/payments/:id/receipt
 *
 * Streams a PDF receipt to the client.
 * Content-Type: application/pdf
 * Content-Disposition: attachment; filename="UC-RCP-XXXXXXXX.pdf"
 *
 * The client (React Native) downloads this via react-native-blob-util
 * directly into the device filesystem, then opens/shares with the
 * native OS share sheet.
 *
 * Security: authenticate + authorize('read', 'Payment') must be mounted
 * on the route before this handler.
 */
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
  // Prevent caching of authenticated receipts
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).end(buffer);
});
