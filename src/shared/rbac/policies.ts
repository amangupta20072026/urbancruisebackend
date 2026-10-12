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
  'read:Notification': anyCustomer,
  'read:Support': anyCustomer,
  'create:Feedback': anyCustomer,
};

export function can(identity: Identity, action: Action, subject: Subject): boolean {
  const rule = MATRIX[`${action}:${subject}`] ?? nobody;
  return rule(identity);
}
