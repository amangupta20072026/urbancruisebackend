/**
 * customer.payments types. Payments live on the `dsrs` booking row.
 * The app's payment id is dsrs.bookingId (e.g. "pay_00110_1"); the INT
 * dsrs.id is internal. dsrs.payment_status is free text.
 */
import type { RowDataPacket } from 'mysql2/promise';

/** Raw dsrs row. */
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

/** Payment list item. */
export type CustomerPaymentListItem = {
  /** bookingId when present, otherwise the numeric id as a string. */
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

/** Payment detail, also used to build the receipt. */
export type CustomerPaymentDetail = CustomerPaymentListItem & {
  customerName: string | null;
  driverName: string | null;
  customerRate: string | null;
  gstAmount: string | null;
  customerAmount: unknown; // parsed JSON
};
