/**
 * customer.payments — routes
 *
 * Mounted at /api/v1/customer/payments in app.ts (step-2).
 *
 * Routes:
 *   GET /api/v1/customer/payments/:id/receipt
 *       → Streams a PDF receipt for a paid payment.
 *         Secured: authenticate + authorize('read', 'Payment').
 */
import { Router } from 'express';
import { authenticate } from '../../../shared/http/middleware/authenticate.js';
import { authorize } from '../../../shared/http/middleware/authorize.js';
import { validate } from '../../../shared/http/middleware/validate.js';
import { paymentIdParamSchema } from './schemas.js';
import { getPaymentReceipt } from './controller.js';

const router = Router();

router.get(
  '/:id/receipt',
  authenticate,
  authorize('read', 'Payment'),
  validate({ params: paymentIdParamSchema }),
  getPaymentReceipt,
);

export default router;
