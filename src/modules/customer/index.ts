/**
 * customer module — public API (STUB)
 * TODO(step-2): compose sub-module routers below.
 *
 * Sub-modules:
 *   - enquiries
 *   - quotations
 *   - bookings
 *   - trips
 *   - payments
 *   - feedback
 *   - referrals
 */
import { Router } from 'express';
import paymentsRouter from './payments/routes.js';

export default {
  mount(): Router {
    const r = Router();
    // Payments: GET /api/v1/customer/payments/:id/receipt
    r.use('/payments', paymentsRouter);
    // TODO(step-2): mount remaining sub-module routers:
    //   r.use('/enquiries', enquiriesRoutes);
    //   r.use('/quotations', quotationsRoutes);
    //   r.use('/bookings', bookingsRoutes);
    //   r.use('/trips', tripsRoutes);
    //   r.use('/feedback', feedbackRoutes);
    //   r.use('/referrals', referralsRoutes);
    return r;
  },
};
