/**
 * ==============================================================================
 * auth.webhook — routes
 * ==============================================================================
 * MSG91 delivery-report receiver. Mounted at /webhooks/msg91 in app.ts and
 * kept OFF the /api/v1/auth prefix — MSG91 configures this URL in their
 * dashboard, so it must be stable and not share the versioned API surface.
 *
 * Route:
 *   POST /webhooks/msg91/:token/delivery
 *
 * No authenticate/authorize middleware — the URL-embedded token IS the
 * authentication, checked by requireMsg91Token (webhook/controller.ts).
 * No validate() middleware either — MSG91's payload shapes vary across
 * their SMS products; the controller parses defensively rather than
 * enforcing one Zod schema and 4xx-ing the others.
 * ==============================================================================
 */
import express, { Router } from 'express';
import { WEBHOOK_BODY_LIMIT } from '../../../config/constants.js';
import { requireMsg91Token, postMsg91Dlr } from './controller.js';

const router = Router();

// ORDER MATTERS (audit fix #15): token check → body parsers → handler.
// This router is mounted BEFORE the app's global body parsers, so nothing
// has read the body yet. Verifying the URL token first means an
// unauthenticated caller is rejected before a single body byte is parsed,
// and only MSG91 gets the larger WEBHOOK_BODY_LIMIT for its DLR batches.
router.post(
  '/msg91/:token/delivery',
  requireMsg91Token,
  express.json({ limit: WEBHOOK_BODY_LIMIT }),
  express.urlencoded({ extended: true, limit: WEBHOOK_BODY_LIMIT }),
  postMsg91Dlr,
);

export default router;
