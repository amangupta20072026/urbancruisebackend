/** Resource kinds used by authorize() (a kind, not a specific record). */

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
