/**
 * customer.payments service: builds the receipt PDF for a paid payment.
 * The payment is loaded by bookingId and scoped to the caller's customer_id.
 */
import { NotFoundError, AppError } from '../../../shared/errors/index.js';
import type { Identity } from '../../../shared/types/identity.js';
import { sha256 } from '../../../shared/utils/crypto.js';
import * as repo from './repository.js';
import { renderReceipt, type ReceiptData } from './receipt-template.js';

export type ReceiptResult = {
  buffer: Buffer;
  filename: string;
};

/** payment_status values (case-insensitive) that mean fully paid. The column is free text. */
const PAID_STATUSES = new Set(['paid', 'full', 'settled', 'completed', 'done', 'received']);

function isPaidStatus(status: string | null): boolean {
  if (!status) return false;
  return PAID_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Reads paymentMethod, transactionId and paidAt from the customer_amount
 * JSON. Missing values stay null: a receipt is a financial record, so never
 * fill gaps with defaults or the current time.
 */
function extractPaymentMeta(customerAmount: unknown): {
  paymentMethod: string | null;
  transactionId: string | null;
  paidAt: string | null;
} {
  const a =
    customerAmount && typeof customerAmount === 'object'
      ? (customerAmount as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  const paidAt = str(a['paidAt']);
  return {
    paymentMethod: str(a['paymentMethod']),
    transactionId: str(a['transactionId']),
    paidAt: paidAt !== null && !Number.isNaN(Date.parse(paidAt)) ? paidAt : null,
  };
}

/**
 * Receipt number derived from the payment key: the same on every download,
 * and hashed so it doesn't reveal volume or let anyone guess the next one.
 */
export function receiptNumberFor(paymentKey: string): string {
  return `UC-RCP-${sha256(`receipt:v1:${paymentKey}`).slice(0, 10).toUpperCase()}`;
}

export async function generateReceipt(
  paymentId: string,
  identity: Identity,
): Promise<ReceiptResult> {
  // Scoped to the caller's customer_id.
  const payment = await repo.findPaymentByBookingId(paymentId, identity.entityId);
  if (!payment) {
    throw new NotFoundError(`Payment not found for bookingId: ${paymentId}`, 'PAYMENT_NOT_FOUND');
  }

  // Only paid payments get a receipt.
  if (!isPaidStatus(payment.paymentStatus)) {
    throw new AppError({
      statusCode: 422,
      message: `Receipt is only available for paid payments. Current status: "${payment.paymentStatus ?? 'unknown'}"`,
      code: 'RECEIPT_NOT_AVAILABLE',
    });
  }

  const { paymentMethod, transactionId, paidAt } = extractPaymentMeta(payment.customerAmount);
  const receiptNumber = receiptNumberFor(payment.bookingId ?? payment.id);

  // total is free text: strip everything but digits and the decimal point.
  const amountNum = parseFloat((payment.totalAmount ?? '0').replace(/[^0-9.]/g, '')) || 0;

  const data: ReceiptData = {
    receiptNumber,
    paymentId: payment.bookingId ?? payment.id, // display id
    transactionId,
    paymentMethod,
    paymentEventAt: paidAt,
    amount: amountNum,
    travelDate: payment.date ?? '—',
    vehicleType: payment.vehicles ?? '—',
    customerName: payment.customerName ?? '—',
    generatedAt: new Date().toISOString(),
  };

  const buffer = await renderReceipt(data);
  return { buffer, filename: `${receiptNumber}.pdf` };
}
