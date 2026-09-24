/**
 * customer.payments — Zod schemas
 */
import { z } from 'zod';

export const paymentIdParamSchema = z.object({
  id: z.string().min(1, 'Payment ID is required'),
});
