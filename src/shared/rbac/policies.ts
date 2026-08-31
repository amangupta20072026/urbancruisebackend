/**
 * ==============================================================================
 * RBAC policies — coarse role×action×subject matrix
 * ==============================================================================
 * `can(identity, action, subject)` answers: "Is this ROLE allowed to perform
 * ACTION on any SUBJECT of this kind, in principle?" That's it. Whether the
 * user can actually operate on SUBJECT #123 depends on:
 *   1. tenant scoping (repository WHERE clause on identity.entityId)
 *   2. instance policy (module's policy.canOperate)
 *
 * SCOPE (step-one): only 'customer'. When vendor/driver/uc land, add rules
 * here and TypeScript's exhaustive checks on the Role union will refuse to
 * compile until every relevant subject has explicit coverage.
 *
 * Deliberately kept in ONE file so a security auditor has ONE table to read.
 * If policies branch on sub-role (e.g. corporate booking-person can't delete
 * a booking), express it here — not scattered across controllers.
 * ==============================================================================
 */
import type { Identity } from '../types/identity.js';
import type { Action } from './actions.js';
import type { Subject } from './subjects.js';

type Rule = (id: Identity) => boolean;

const anyCustomer: Rule = id => id.role === 'customer';
const nobody: Rule = () => false;

/**
 * Corporate admin can do destructive things a corporate booking-person can't.
 * Personal / agent customers have subRole=null and don't hit this branch.
 */
const corporateAdminOnly: Rule = id => id.role === 'customer' && id.subRole === 'admin';

/**
 * Matrix key = `${action}:${subject}`. Each cell is a predicate over Identity.
 * Missing key = deny by default. Add new rows explicitly.
 */
const MATRIX: Record<string, Rule> = {
  // Enquiries — any customer can create + read their own.
  'read:Enquiry': anyCustomer,
  'create:Enquiry': anyCustomer,
  'update:Enquiry': anyCustomer,

  // Quotations — customer can read + accept/confirm; creation is UC-side (TBD).
  'read:Quotation': anyCustomer,
  'confirm:Quotation': anyCustomer,

  // Bookings
  'read:Booking': anyCustomer,
  'create:Booking': anyCustomer,
  'update:Booking': anyCustomer,
  'acknowledge:Booking': anyCustomer,
  // Deleting a booking is high-impact — corporate booking-persons should NOT
  // be able to erase records their admin depends on for reconciliation.
  'delete:Booking': corporateAdminOnly,

  // Trips (read-only from customer side; state transitions are driver/UC-side)
  'read:Trip': anyCustomer,

  // Payments
  'read:Payment': anyCustomer,
  'create:Payment': anyCustomer,

  // Self / notifications / support / feedback
  'read:Customer': anyCustomer,
  'update:Customer': anyCustomer,
  'read:Notification': anyCustomer,
  'read:Support': anyCustomer,
  'create:Feedback': anyCustomer,
};

export function can(identity: Identity, action: Action, subject: Subject): boolean {
  const rule = MATRIX[`${action}:${subject}`] ?? nobody;
  return rule(identity);
}
