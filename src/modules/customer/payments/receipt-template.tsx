/**
 * ==============================================================================
 * Receipt PDF Template — @react-pdf/renderer
 * ==============================================================================
 * Design matches the shared mockup exactly:
 *   • UC logo (ucwithtexthindi.png) top-left
 *   • "Payment Receipt" + receipt number top-right
 *   • Generated date + "computer generated" sub-text
 *   • Green hero banner: checkmark + "Payment Successful"
 *   • Amount card: ₹ amount | Payment Status pill
 *   • Payment Details table: Method / ID / TxnID / Paid On / Vehicle / Date
 *   • Security banner (lock icon)
 *   • Thank you footer + QR verification code
 *   • Dark footer bar: company name left, website right
 * ==============================================================================
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Page, Text, View, Image, StyleSheet, Font } from '@react-pdf/renderer';

/* ── Resolve assets directory ── */
// process.cwd() = project root (where npm run dev is started).
// Works in both dev (tsx) and prod (node dist/) because the server is always
// started from the project root. The assets folder stays at src/assets.
const ASSETS_DIR = path.join(process.cwd(), 'src', 'assets');

function loadImage(filename: string): string {
  const p = path.join(ASSETS_DIR, filename);
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return ''; // file not found — Image component will simply not render
  }
}

// Load at module init (cached for the process lifetime)
const LOGO_URI = loadImage('ucwithtexthindi.png');

/* ── Colours ── */
const C = {
  primary: '#1B5E37', // dark green — logo green
  primaryLight: '#2E7D52', // header green
  primaryTint: '#E8F5EE', // pale green backgrounds
  successGreen: '#4CAF50', // checkmark circle
  pillGreen: '#E8F5EE',
  pillText: '#2E7D52',
  white: '#FFFFFF',
  offWhite: '#F8FAFB',
  textDark: '#1A1A2E',
  textMid: '#444',
  textLight: '#6B7280',
  border: '#E0E0E0',
  divider: '#EEEEEE',
  footerBg: '#1A2340', // dark navy footer
};

Font.registerHyphenationCallback(word => [word]);

const s = StyleSheet.create({
  page: {
    backgroundColor: C.white,
    fontFamily: 'Helvetica',
    paddingVertical: 0,
    paddingHorizontal: 0,
    fontSize: 10,
  },

  /* ── Top white header area ── */
  headerArea: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 36,
    paddingTop: 28,
    paddingBottom: 20,
  },
  logo: { width: 140, height: 52, objectFit: 'contain' },
  headerRight: { alignItems: 'flex-end' },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: C.textDark,
  },
  headerRcptNo: {
    fontSize: 10,
    color: C.primary,
    fontFamily: 'Helvetica-Bold',
    marginTop: 3,
  },
  headerDate: {
    fontSize: 8,
    color: C.textLight,
    marginTop: 3,
    textAlign: 'right',
  },
  headerComputer: {
    fontSize: 8,
    color: C.textLight,
    textAlign: 'right',
  },

  dividerLine: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 36,
    marginBottom: 20,
  },

  /* ── Hero green banner ── */
  heroBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.primaryTint,
    marginHorizontal: 36,
    borderRadius: 10,
    padding: 18,
    marginBottom: 20,
    gap: 16,
  },
  heroCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.successGreen,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCheck: {
    fontSize: 24,
    color: C.white,
    fontFamily: 'Helvetica-Bold',
  },
  heroRight: { flex: 1 },
  heroTitle: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: C.primaryLight,
    marginBottom: 4,
  },
  heroSub: { fontSize: 9.5, color: C.textMid, marginBottom: 1 },

  /* ── Amount card ── */
  amountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 18,
    marginBottom: 20,
  },
  amountLeft: {},
  amtLabel: { fontSize: 9, color: C.textLight, marginBottom: 5 },
  amtValue: {
    fontSize: 30,
    fontFamily: 'Helvetica-Bold',
    color: C.primary,
    marginBottom: 3,
  },
  amtWords: { fontSize: 8, color: C.textLight },
  amountDivider: {
    width: 1,
    height: 60,
    backgroundColor: C.border,
    marginHorizontal: 16,
  },
  amountRight: { alignItems: 'flex-end' },
  statusLabel: { fontSize: 9, color: C.textLight, marginBottom: 6 },
  statusPill: {
    backgroundColor: C.pillGreen,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  statusPillText: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: C.pillText,
  },

  /* ── Payment Details section ── */
  section: { marginHorizontal: 36, marginBottom: 20 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: C.textDark,
    marginBottom: 10,
  },
  tableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: C.divider,
  },
  tableRowLast: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  tableLabel: { fontSize: 9.5, color: C.textLight },
  tableValue: {
    fontSize: 9.5,
    color: C.textDark,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
    maxWidth: '60%',
  },
  tableValueGreen: {
    fontSize: 9.5,
    color: C.primary,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
    maxWidth: '60%',
  },

  /* ── Security banner ── */
  securityBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 36,
    backgroundColor: C.primaryTint,
    borderRadius: 8,
    padding: 14,
    marginBottom: 24,
    gap: 12,
  },
  lockCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIcon: { fontSize: 15, color: C.white },
  securityText: { flex: 1 },
  securityBold: {
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: C.textDark,
    marginBottom: 2,
  },
  securitySub: { fontSize: 8, color: C.textLight },

  /* ── Thank you + QR footer ── */
  thankYouArea: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginHorizontal: 36,
    marginBottom: 24,
  },
  thankYouLeft: {},
  thankYouTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: C.primary,
    marginBottom: 3,
  },
  thankYouSub: { fontSize: 8.5, color: C.textLight },
  qrArea: { alignItems: 'center' },
  qrPlaceholder: {
    width: 64,
    height: 64,
    backgroundColor: C.offWhite,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrText: { fontSize: 6, color: C.textLight, marginTop: 4, textAlign: 'center' },

  /* ── Dark navy footer bar ── */
  footerBar: {
    backgroundColor: C.footerBg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 14,
  },
  footerLeft: {},
  footerCompany: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: C.white,
    marginBottom: 2,
  },
  footerTagline: { fontSize: 7.5, color: '#9CA3AF' },
  footerWebsite: { fontSize: 9, color: '#9CA3AF' },
});

/* ── Number helpers ── */

function formatRupees(n: number): string {
  return `\u20B9${n.toLocaleString('en-IN')}`;
}

function rupeesToWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '';
  const n = Math.floor(amount);
  if (n === 0) return 'Rupees Zero Only';
  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];
  const tens = [
    '',
    '',
    'Twenty',
    'Thirty',
    'Forty',
    'Fifty',
    'Sixty',
    'Seventy',
    'Eighty',
    'Ninety',
  ];
  const two = (x: number): string =>
    x < 20
      ? (ones[x] ?? '')
      : (tens[Math.floor(x / 10)] ?? '') + (x % 10 ? ' ' + (ones[x % 10] ?? '') : '');
  const three = (x: number): string => {
    const h = Math.floor(x / 100),
      r = x % 100,
      p: string[] = [];
    if (h) p.push(`${ones[h] ?? ''} Hundred`);
    if (r) p.push(two(r));
    return p.join(' ');
  };
  const cr = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thou = Math.floor((n % 100000) / 1000);
  const rem = n % 1000;
  const p: string[] = [];
  if (cr) p.push(`${two(cr)} Crore`);
  if (lakh) p.push(`${two(lakh)} Lakh`);
  if (thou) p.push(`${two(thou)} Thousand`);
  if (rem) p.push(three(rem));
  return `Rupees ${p.join(' ')} Only`;
}

function fmtDt(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/* ── ReceiptData ── */

export type ReceiptData = {
  receiptNumber: string;
  paymentId: string;
  transactionId: string;
  paymentMethod: string;
  paymentEventAt: string;
  amount: number;
  travelDate: string;
  vehicleType: string;
  customerName: string;
  generatedAt: string;
};

/* ── Document ── */

export const ReceiptDocument: React.FC<{ data: ReceiptData }> = ({ data }) => (
  <Document
    title={`Urban Cruise Receipt – ${data.receiptNumber}`}
    author="Urban Cruise"
    subject="Payment Receipt"
    creator="Urban Cruise Backend"
    producer="@react-pdf/renderer"
  >
    <Page size="A4" style={s.page}>
      {/* ── Header: logo left, receipt info right ── */}
      <View style={s.headerArea}>
        <View>
          {LOGO_URI ? (
            <Image style={s.logo} src={LOGO_URI} />
          ) : (
            <Text style={{ fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.primary }}>
              Urban Cruise
            </Text>
          )}
        </View>
        <View style={s.headerRight}>
          <Text style={s.headerTitle}>Payment Receipt</Text>
          <Text style={s.headerRcptNo}>#{data.receiptNumber}</Text>
          <Text style={s.headerDate}>Generated on: {fmtDt(data.generatedAt)}</Text>
          <Text style={s.headerComputer}>This is a computer generated receipt.</Text>
        </View>
      </View>

      <View style={s.dividerLine} />

      {/* ── Hero: green check + Payment Successful ── */}
      <View style={s.heroBanner}>
        <View style={s.heroCircle}>
          <Text style={s.heroCheck}>✓</Text>
        </View>
        <View style={s.heroRight}>
          <Text style={s.heroTitle}>Payment Successful</Text>
          <Text style={s.heroSub}>Your payment has been completed successfully.</Text>
          <Text style={s.heroSub}>Thank you for choosing Urban Cruise.</Text>
        </View>
      </View>

      {/* ── Amount card ── */}
      <View style={s.amountCard}>
        <View style={s.amountLeft}>
          <Text style={s.amtLabel}>Amount Paid</Text>
          <Text style={s.amtValue}>{formatRupees(data.amount)}</Text>
          <Text style={s.amtWords}>{rupeesToWords(data.amount)}</Text>
        </View>
        <View style={s.amountDivider} />
        <View style={s.amountRight}>
          <Text style={s.statusLabel}>Payment Status</Text>
          <View style={s.statusPill}>
            <Text style={s.statusPillText}>Paid</Text>
          </View>
        </View>
      </View>

      {/* ── Payment Details ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Payment Details</Text>

        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Payment Method</Text>
          <Text style={s.tableValue}>{data.paymentMethod}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Payment ID</Text>
          <Text style={s.tableValueGreen}>{data.paymentId}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Transaction ID</Text>
          <Text style={s.tableValueGreen}>{data.transactionId}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Paid On</Text>
          <Text style={s.tableValue}>{fmtDt(data.paymentEventAt)}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Vehicle</Text>
          <Text style={s.tableValue}>{data.vehicleType}</Text>
        </View>
        <View style={s.tableRowLast}>
          <Text style={s.tableLabel}>Travel Date</Text>
          <Text style={s.tableValue}>{data.travelDate}</Text>
        </View>
      </View>

      {/* ── Security banner ── */}
      <View style={s.securityBanner}>
        <View style={s.lockCircle}>
          <Text style={s.lockIcon}>🔒</Text>
        </View>
        <View style={s.securityText}>
          <Text style={s.securityBold}>
            This payment was processed securely using an encrypted connection.
          </Text>
          <Text style={s.securitySub}>Your payment information is safe with us.</Text>
        </View>
      </View>

      {/* ── Thank you + QR area ── */}
      <View style={s.thankYouArea}>
        <View style={s.thankYouLeft}>
          <Text style={s.thankYouTitle}>Thank you for choosing Urban Cruise!</Text>
          <Text style={s.thankYouSub}>Safe Journeys. A Better Tomorrow.</Text>
        </View>
        <View style={s.qrArea}>
          {/* QR placeholder — replace with real QR image when available */}
          <View style={s.qrPlaceholder}>
            <Text style={{ fontSize: 18, color: C.textLight }}>▦</Text>
          </View>
          <Text style={s.qrText}>Scan to verify{'\n'}this receipt</Text>
        </View>
      </View>

      {/* ── Dark footer bar ── */}
      <View style={s.footerBar}>
        <View style={s.footerLeft}>
          <Text style={s.footerCompany}>Urban Cruise Private Limited</Text>
          <Text style={s.footerTagline}>India's Trusted Travel Partner</Text>
        </View>
        <Text style={s.footerWebsite}>www.urbancruise.in</Text>
      </View>
    </Page>
  </Document>
);

export async function renderReceipt(data: ReceiptData): Promise<Buffer> {
  const { renderToBuffer } = await import('@react-pdf/renderer');
  const element = <ReceiptDocument data={data} />;
  return renderToBuffer(element);
}
