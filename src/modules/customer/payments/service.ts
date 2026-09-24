/**
 * ==============================================================================
 * customer.payments — service
 * ==============================================================================
 * Orchestrates receipt PDF generation:
 *
 *   1. Load dsrs row by bookingId (the human-readable ID the app sends)
 *   2. Guard: only paid rows get a receipt
 *   3. Build ReceiptData and render via @react-pdf/renderer (server-side, no browser)
 *   4. Return buffer + filename to the controller
 *
 * PAYMENT STATUS NOTE:
 *   dsrs.payment_status is a free-text varchar — your team stores values like:
 *   "Paid", "paid", "PAID", "Full", "Settled", "Partial", "Pending", null, ""
 *   The isPaid check below is case-insensitive and covers all common variants.
 *   If your team uses different values, add them to PAID_STATUSES below.
 * ==============================================================================
 */
import { NotFoundError, AppError } from '../../../shared/errors/index.js';
import type { Identity } from '../../../shared/types/identity.js';
import { newId } from '../../../shared/utils/id.js';
import * as repo from './repository.js';
import { renderReceipt, type ReceiptData } from './receipt-template.js';

export type ReceiptResult = {
  buffer: Buffer;
  filename: string;
};

/**
 * All payment_status values your team uses that mean "fully paid".
 * Case-insensitive. Add more if your data has other variants.
 */
const PAID_STATUSES = new Set(['paid', 'full', 'settled', 'completed', 'done', 'received']);

function isPaidStatus(status: string | null): boolean {
  if (!status) return false;
  return PAID_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Extract payment instrument details from the customer_amount JSON field.
 *
 * The customer_amount column is a JSON blob. Your team may store fields
 * like { paymentMethod, transactionId, paidAt } in it once the gateway
 * integration is live. Until then this returns sensible fallbacks.
 */
function extractPaymentMeta(customerAmount: unknown): {
  paymentMethod: string;
  transactionId: string;
  paidAt: string;
} {
  if (customerAmount && typeof customerAmount === 'object') {
    const a = customerAmount as Record<string, unknown>;
    return {
      paymentMethod: typeof a['paymentMethod'] === 'string' ? a['paymentMethod'] : 'UPI',
      transactionId: typeof a['transactionId'] === 'string' ? a['transactionId'] : '—',
      paidAt: typeof a['paidAt'] === 'string' ? a['paidAt'] : new Date().toISOString(),
    };
  }
  return {
    paymentMethod: 'UPI',
    transactionId: '—',
    paidAt: new Date().toISOString(),
  };
}

export async function generateReceipt(
  paymentId: string,
  identity: Identity,
): Promise<ReceiptResult> {
  // 1. Load by bookingId (the varchar the frontend sends, e.g. "pay_00110_1")
  //    findPaymentByBookingId already filters by customer_id — tenant scoped.
  const payment = await repo.findPaymentByBookingId(paymentId, identity.entityId);
  if (!payment) {
    throw new NotFoundError(`Payment not found for bookingId: ${paymentId}`, 'PAYMENT_NOT_FOUND');
  }

  // 2. Guard — only paid bookings get a receipt
  if (!isPaidStatus(payment.paymentStatus)) {
    throw new AppError({
      statusCode: 422,
      message: `Receipt is only available for paid payments. Current status: "${payment.paymentStatus ?? 'unknown'}"`,
      code: 'RECEIPT_NOT_AVAILABLE',
    });
  }

  // 3. Build receipt data
  const { paymentMethod, transactionId, paidAt } = extractPaymentMeta(payment.customerAmount);
  const receiptNumber = `UC-RCP-${newId().slice(0, 8).toUpperCase()}`;

  // Parse total amount — strip currency symbols, commas, spaces
  const amountNum = parseFloat((payment.totalAmount ?? '0').replace(/[^0-9.]/g, '')) || 0;

  const data: ReceiptData = {
    receiptNumber,
    paymentId: payment.bookingId ?? payment.id, // use bookingId as the display ID
    transactionId,
    paymentMethod,
    paymentEventAt: paidAt,
    amount: amountNum,
    travelDate: payment.date ?? '—',
    vehicleType: payment.vehicles ?? '—',
    customerName: payment.customerName ?? '—',
    generatedAt: new Date().toISOString(),
  };

  // 4. Render PDF
  const buffer = await renderReceipt(data);
  return { buffer, filename: `${receiptNumber}.pdf` };
}
