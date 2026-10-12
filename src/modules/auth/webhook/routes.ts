/**
 * MSG91 delivery-report webhook: POST /webhooks/msg91/:token/delivery.
 * Outside /api/v1 because MSG91 stores this URL. The URL token is the
 * authentication. No Zod validation: MSG91 payload shapes vary, so the
 * controller parses defensively.
 */
import express, { Router } from 'express';
import { WEBHOOK_BODY_LIMIT } from '../../../config/constants.js';
import { requireMsg91Token, postMsg91Dlr } from './controller.js';

const router = Router();

// Order matters: check the token before parsing any body, so only MSG91
// gets the larger WEBHOOK_BODY_LIMIT. Mounted before the global parsers.
router.post(
  '/msg91/:token/delivery',
  requireMsg91Token,
  express.json({ limit: WEBHOOK_BODY_LIMIT }),
  express.urlencoded({ extended: true, limit: WEBHOOK_BODY_LIMIT }),
  postMsg91Dlr,
);

export default router;
