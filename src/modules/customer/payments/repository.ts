/**
 * customer.payments — repository
 * DB table: `dsrs`
 * Tenant scope: customer_id column (ADR-0003).
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from '../../../shared/db/pool.js';
import type { CustomerPaymentListItem, CustomerPaymentDetail } from './types.js';

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToListItem(r: RowDataPacket): CustomerPaymentListItem {
  return {
    id: (r['bookingId'] as string | null) ?? String(r['id']),
    bookingId: (r['bookingId'] as string | null) ?? null,
    date: r['dsr_date'] ? (r['dsr_date'] as Date).toISOString().slice(0, 10) : null,
    vehicles: (r['dsr_vehicles'] as string | null) ?? null,
    vendorName: (r['vendor_name'] as string | null) ?? null,
    totalAmount: (r['total'] as string | null) ?? null,
    paymentStatus: (r['payment_status'] as string | null) ?? null,
    balanceAmount: (r['balance_amount'] as string | null) ?? null,
    createdAt: (r['created_at'] as Date).toISOString(),
  };
}

function rowToDetail(r: RowDataPacket): CustomerPaymentDetail {
  return {
    ...rowToListItem(r),
    customerName: (r['full_name'] as string | null) ?? null,
    driverName: (r['driver'] as string | null) ?? null,
    customerRate: (r['customer_rate'] as string | null) ?? null,
    gstAmount: (r['gst_amt'] as string | null) ?? null,
    customerAmount: parseJson(r['customer_amount'] as string | null),
  };
}

export async function listPayments(
  customerId: number,
  page: number,
  pageSize: number,
): Promise<{ rows: CustomerPaymentListItem[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const [[countRow], [rows]] = await Promise.all([
    pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM dsrs WHERE customer_id = ?`, [
      customerId,
    ]),
    pool.execute<RowDataPacket[]>(
      `SELECT id, bookingId, dsr_date, dsr_vehicles, vendor_name,
              total, payment_status, balance_amount, created_at
         FROM dsrs
        WHERE customer_id = ?
        ORDER BY dsr_date DESC, created_at DESC
        LIMIT ? OFFSET ?`,
      [customerId, pageSize, offset],
    ),
  ]);
  return {
    total: Number(countRow[0]!['total']),
    rows: rows.map(rowToListItem),
  };
}

export async function findPaymentByBookingId(
  bookingId: string,
  customerId: string,
): Promise<CustomerPaymentDetail | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, bookingId, full_name, dsr_date, dsr_vehicles, vendor_name, driver,
            customer_rate, gst_amt, total, payment_status, balance_amount,
            customer_amount, created_at
       FROM dsrs
      WHERE bookingId = ? AND customer_id = ?
      LIMIT 1`,
    [bookingId, Number(customerId)],
  );
  return rows.length ? rowToDetail(rows[0]!) : null;
}
