/**
 * ==============================================================================
 * customer.payments — types
 * ==============================================================================
 * DB source: `dsrs` table — payment columns within the booking record.
 *
 * IMPORTANT COLUMN MAPPING:
 *   dsrs.id        → INT PK  (internal, never exposed as PaymentId)
 *   dsrs.bookingId → VARCHAR (this IS the PaymentId the app uses, e.g. "pay_00110_1")
 *   dsrs.full_name → customer name on the booking
 *   dsrs.payment_status → free-text ("Paid", "paid", "Partial", "Pending", etc.)
 * ==============================================================================
 */
import type { RowDataPacket } from 'mysql2/promise';

/** Raw DB row from dsrs */
export type PaymentRow = RowDataPacket & {
  id: number;
  customer_id: number | null;
  bookingId: string | null;
  full_name: string | null;
  dsr_date: Date | null;
  dsr_vehicles: string | null;
  vendor_name: string | null;
  driver: string | null;
  customer_rate: string | null;
  gst_amt: string | null;
  total: string | null;
  payment_status: string | null;
  balance_amount: string | null;
  customer_amount: string | null; // JSON
  created_at: Date;
};

/** DTO for the payment list tab */
export type CustomerPaymentListItem = {
  /** bookingId varchar if present, else string(id) */
  id: string;
  bookingId: string | null;
  date: string | null;
  vehicles: string | null;
  vendorName: string | null;
  totalAmount: string | null;
  paymentStatus: string | null;
  balanceAmount: string | null;
  createdAt: string;
};

/** DTO for the payment detail sheet + receipt generation */
export type CustomerPaymentDetail = CustomerPaymentListItem & {
  customerName: string | null;
  driverName: string | null;
  customerRate: string | null;
  gstAmount: string | null;
  customerAmount: unknown; // parsed JSON
};
