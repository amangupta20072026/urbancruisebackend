/**
 * customer.payments — routes
 *
 * Mounted at /api/v1/customer/payments in app.ts (step-2).
 *
 * Routes:
 *   GET /api/v1/customer/payments/:id/receipt
 *       → Streams a PDF receipt for a paid payment.
 *         Secured: authenticate + authorize('read', 'Payment').
 *         Rate-limited PER CUSTOMER (audit fix #13): rendering a PDF is
 *         CPU-heavy and blocks the event loop, so one account hammering this
 *         endpoint could slow the API for everyone. The limit is keyed by
 *         the authenticated account (not IP) and shared across PM2 workers.
 */
import { Router } from 'express';
import { authenticate } from '../../../shared/http/middleware/authenticate.js';
import { authorize } from '../../../shared/http/middleware/authorize.js';
import { validate } from '../../../shared/http/middleware/validate.js';
import { createRateLimiter } from '../../../shared/http/middleware/rateLimit.js';
import { paymentIdParamSchema } from './schemas.js';
import { getPaymentReceipt } from './controller.js';

const router = Router();

/** 10 receipts per minute per account — plenty for a human, a wall for a script. */
const receiptLimiter = createRateLimiter({
  name: 'customer-receipt',
  windowMs: 60_000,
  limit: 10,
  message: 'Too many receipt downloads. Please wait a minute and try again.',
  // Runs after authenticate, so the identity is always present here.
  keyGenerator: req => `${req.identity?.role ?? 'anon'}:${req.identity?.entityId ?? req.ip ?? ''}`,
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
