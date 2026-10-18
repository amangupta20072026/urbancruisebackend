/**
 * Role-level permission table used by authorize(). Answers only "may this
 * role do this action on this kind of resource". Access to a specific record
 * must still be checked in the repository/service (e.g. by entityId).
 * Anything not listed is denied.
 */
import type { Identity } from '../types/identity.js';
import type { Action } from './actions.js';
import type { Subject } from './subjects.js';

type Rule = (id: Identity) => boolean;

const anyCustomer: Rule = id => id.role === 'customer';
const nobody: Rule = () => false;
/**
 * Any signed-in role. Only for "own data" resources whose repository
 * scopes every query by the caller's (role, entityId) from the access
 * token — never for shared business records. Disabled roles are still
 * rejected earlier by authenticate (ENABLED_ROLES).
 */
const anySignedIn: Rule = () => true;

// Key: `${action}:${subject}`.
const MATRIX: Record<string, Rule> = {
  // Enquiries
  'read:Enquiry': anyCustomer,
  'create:Enquiry': anyCustomer,
  'update:Enquiry': anyCustomer,

  // Quotations
  'read:Quotation': anyCustomer,
  'confirm:Quotation': anyCustomer,

  // Bookings
  'read:Booking': anyCustomer,
  'create:Booking': anyCustomer,
  'update:Booking': anyCustomer,
  'acknowledge:Booking': anyCustomer,

  // Trips (read-only for customers)
  'read:Trip': anyCustomer,

  // Payments
  'read:Payment': anyCustomer,
  'create:Payment': anyCustomer,

  // Profile, notifications, support, feedback
  'read:Customer': anyCustomer,
  'update:Customer': anyCustomer,
  // Own inbox: notifications/repository.ts scopes every query by
  // (role, entity_id) from the token, so every role sees only its own.
  'read:Notification': anySignedIn,
  'read:Support': anyCustomer,
  'create:Feedback': anyCustomer,
};

export function can(identity: Identity, action: Action, subject: Subject): boolean {
  const rule = MATRIX[`${action}:${subject}`] ?? nobody;
  return rule(identity);
}
