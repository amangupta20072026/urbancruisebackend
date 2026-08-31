/**
 * ==============================================================================
 * authorize(action, subject) — coarse RBAC middleware
 * ==============================================================================
 * Runs AFTER authenticate. If the identity's role isn't allowed to perform
 * `action` on `subject` per src/shared/rbac/policies.ts → 403 immediately.
 *
 * Instance-level checks (this specific booking, this specific user's referral
 * link) still happen in the service layer via module policy.canOperate().
 * ==============================================================================
 */
import type { RequestHandler } from 'express';
import { ForbiddenError } from '../../errors/index.js';
import { can } from '../../rbac/policies.js';
import type { Action } from '../../rbac/actions.js';
import type { Subject } from '../../rbac/subjects.js';

export function authorize(action: Action, subject: Subject): RequestHandler {
  return (req, _res, next) => {
    if (!req.identity) throw new ForbiddenError('Not authenticated.', 'AUTH_UNAUTHENTICATED');
    if (!can(req.identity, action, subject)) {
      throw new ForbiddenError(
        `Action ${action} on ${subject} not permitted for role ${req.identity.role}.`,
        'RBAC_DENIED',
        {
          action,
          subject,
          role: req.identity.role,
        },
      );
    }
    next();
  };
}
