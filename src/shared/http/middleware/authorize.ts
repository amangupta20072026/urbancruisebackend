/**
 * Role-level permission check (403 if denied). Use after authenticate.
 * Checks on a specific record (e.g. "is this booking yours?") belong in the
 * service layer.
 */
import type { RequestHandler } from 'express';
import { ForbiddenError } from '../../errors/index.js';
import { can } from '../../rbac/policies.js';
import type { Action } from '../../rbac/actions.js';
import type { Subject } from '../../rbac/subjects.js';

/**
 * Express middleware that checks the authenticated user's role against the
 * given action and subject. Use after authenticate.
 * @param action The action to check (e.g. 'read', 'create', 'delete').
 * @param subject The subject to check (e.g. 'booking', 'user').
 */
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
