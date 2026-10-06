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
 *
 * KEY FALLBACK (fix — ERR_ERL_KEY_GEN_IPV6):
 *   The limiter runs after `authenticate`, so `req.identity` is always set
 *   and the key is `<role>:<entityId>`. If that ever changes, the fallback
 *   is the client IP passed through `ipKeyGenerator`, which groups an IPv6
 *   address with its /64 block. A raw `req.ip` would let one IPv6 user
 *   rotate addresses inside their block and bypass the limit — that is what
 *   express-rate-limit's ERR_ERL_KEY_GEN_IPV6 check warns about.
 */
import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
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
  // Runs after authenticate, so the identity is always present here. The
  // IP fallback is normalised with ipKeyGenerator (IPv6 → /64) just in case.
  keyGenerator: req =>
    req.identity
      ? `${req.identity.role}:${req.identity.entityId}`
      : `anon:${ipKeyGenerator(req.ip ?? '')}`,
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
