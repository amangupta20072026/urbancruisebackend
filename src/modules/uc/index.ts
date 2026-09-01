/**
 * uc module — public API (STUB)
 * TODO(step-2): compose sub-module routers below.
 *
 * Sub-modules:
 *   - customers
 *   - enquiries
 *   - quotations
 *   - bookings
 *   - trips
 *   - assignments
 *   - vendors
 *   - staff
 *   - drivers
 *   - finance
 *   - payments
 *   - dashboard
 *   - performance
 *   - issues
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
