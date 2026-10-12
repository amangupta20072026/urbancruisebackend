/**
 * customer.payments routes, mounted at /api/v1/customer/payments.
 *
 * GET /:id/receipt — PDF receipt for a paid payment. PDF rendering is
 * CPU-heavy and blocks the event loop, so it has a per-account limit
 * shared across PM2 workers.
 */
import { Router } from 'express';
import { authenticate } from '../../../shared/http/middleware/authenticate.js';
import { authorize } from '../../../shared/http/middleware/authorize.js';
import { validate } from '../../../shared/http/middleware/validate.js';
import { clientIpKey, createRateLimiter } from '../../../shared/http/middleware/rateLimit.js';
import { paymentIdParamSchema } from './schemas.js';
import { getPaymentReceipt } from './controller.js';

const router = Router();

/** 10 receipts per minute per account. */
const receiptLimiter = createRateLimiter({
  name: 'customer-receipt',
  windowMs: 60_000,
  limit: 10,
  message: 'Too many receipt downloads. Please wait a minute and try again.',
  // Keyed by account (set by authenticate). The fallback uses clientIpKey()
  // so IPv6 clients are grouped by /64 and can't rotate around the limit.
  keyGenerator: req =>
    req.identity ? `${req.identity.role}:${req.identity.entityId}` : `anon:${clientIpKey(req)}`,
});

router.get(
  '/:id/receipt',
  authenticate,
  authorize('read', 'Payment'),
  receiptLimiter,
  validate({ params: paymentIdParamSchema }),
  getPaymentReceipt,
);

export default router;
