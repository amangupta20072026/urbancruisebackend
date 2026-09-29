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
 * authentication. See webhook/controller.ts for the verification call.
 * No validate() middleware either — MSG91's payload shapes vary across
 * their SMS products; the controller parses defensively rather than
 * enforcing one Zod schema and 4xx-ing the others.
 * ==============================================================================
 */
import { Router } from 'express';
import { postMsg91Dlr } from './controller.js';

const router = Router();

router.post('/msg91/:token/delivery', postMsg91Dlr);

export default router;
