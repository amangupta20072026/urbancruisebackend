/**
 * Payment receipts — audit item #13.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../repository.js', () => ({ findPaymentByBookingId: vi.fn() }));
vi.mock('../receipt-template.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../receipt-template.js')>()),
  renderReceipt: vi.fn(async () => Buffer.from('%PDF-fake')),
}));

import { generateReceipt, receiptNumberFor } from '../service.js';
import * as repo from '../repository.js';
import { renderReceipt, RECEIPT_LOGO_FILE, type ReceiptData } from '../receipt-template.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const findPayment = vi.mocked(repo.findPaymentByBookingId);
const render = vi.mocked(renderReceipt);
const IDENTITY = {
  userId: '42',
  role: 'customer' as const,
  subRole: null,
  entityId: '42',
  sessionId: 's',
};

function payment(customerAmount: unknown) {
  return {
    id: 'pay_00110_1',
    bookingId: 'pay_00110_1',
    date: '2026-09-01',
    vehicles: 'Innova',
    vendorName: 'V',
    totalAmount: '4,500.00',
    paymentStatus: 'Paid',
    balanceAmount: '0',
    createdAt: '2026-09-01T00:00:00.000Z',
    customerName: 'Asha',
    driverName: null,
    customerRate: null,
    gstAmount: null,
    customerAmount,
  };
}
const lastData = (): ReceiptData => render.mock.calls.at(-1)![0];

describe('receipts (audit #13 regression)', () => {
  beforeEach(() => {
    findPayment.mockReset();
    render.mockClear();
  });

  it('missing payment details are NOT invented (no "now", no default UPI)', async () => {
    findPayment.mockResolvedValue(payment(null));
    await generateReceipt('pay_00110_1', IDENTITY);
    const d = lastData();
    expect(d.paymentEventAt).toBeNull(); // was: the current time
    expect(d.paymentMethod).toBeNull(); // was: 'UPI'
    expect(d.transactionId).toBeNull(); // was: '—'
  });

  it('real recorded details are used as-is', async () => {
    findPayment.mockResolvedValue(
      payment({ paymentMethod: 'Card', transactionId: 'TXN-9', paidAt: '2026-09-02T10:00:00Z' }),
    );
    await generateReceipt('pay_00110_1', IDENTITY);
    expect(lastData()).toMatchObject({
      paymentMethod: 'Card',
      transactionId: 'TXN-9',
      paymentEventAt: '2026-09-02T10:00:00Z',
    });
  });

  it('an unparseable paidAt is treated as not recorded', async () => {
    findPayment.mockResolvedValue(payment({ paidAt: 'yesterday-ish' }));
    await generateReceipt('pay_00110_1', IDENTITY);
    expect(lastData().paymentEventAt).toBeNull();
  });

  it('the receipt number is STABLE across downloads (was random each time)', async () => {
    findPayment.mockResolvedValue(payment(null));
    const a = await generateReceipt('pay_00110_1', IDENTITY);
    const b = await generateReceipt('pay_00110_1', IDENTITY);
    expect(a.filename).toBe(b.filename);
    expect(lastData().receiptNumber).toBe(receiptNumberFor('pay_00110_1'));
  });

  it('different payments get different, non-sequential numbers', () => {
    const n1 = receiptNumberFor('pay_00110_1');
    const n2 = receiptNumberFor('pay_00110_2');
    expect(n1).not.toBe(n2);
    expect(n1).toMatch(/^UC-RCP-[0-9A-F]{10}$/);
  });

  it('the logo file the template loads actually exists in src/assets', () => {
    const p = fileURLToPath(new URL(`../../../../assets/${RECEIPT_LOGO_FILE}`, import.meta.url));
    expect(existsSync(p)).toBe(true);
  });
});
