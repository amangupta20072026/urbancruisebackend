/**
 * ==============================================================================
 * RBAC subjects — the nouns the authorize() middleware understands
 * ==============================================================================
 * A "subject kind" is a category, not an instance. Instance-level access is
 * decided by a module's policy.canOperate(identity, instance).
 *
 * SCOPE (step-one): only customer-side subjects. Vendor/Vehicle/Driver/Staff/
 * Dashboard/Performance/Issue will be added when their roles land.
 * ==============================================================================
 */

export type Subject =
  | 'Enquiry'
  | 'Quotation'
  | 'Booking'
  | 'Trip'
  | 'Payment'
  | 'Customer'
  | 'Notification'
  | 'Feedback'
  | 'Support';
