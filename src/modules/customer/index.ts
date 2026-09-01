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
export default {
  mount(): Router {
    const r = Router();
    // TODO(step-2): mount sub-module routers here, e.g.
    //   r.use('/bookings', bookingsRoutes);
    return r;
  },
};
