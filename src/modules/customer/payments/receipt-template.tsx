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
 *
 * SRP FIX:
 *   formatRupees / rupeesToWords / fmtDateTime extracted to
 *   shared/utils/currency.ts — they are generic INR utilities, not
 *   template-specific logic. The template is now purely presentational.
 *
 * DIP FIX:
 *   Image loading (fs.readFileSync) is now LAZY — called inside renderReceipt()
 *   rather than at module load time. Importing this file no longer touches the
 *   filesystem, which makes it safe to import in tests and avoids a hard crash
 *   when the assets folder is absent during CI or cold container starts.
 * ==============================================================================
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Page, Text, View, Image, StyleSheet, Font } from '@react-pdf/renderer';
import { formatRupees, rupeesToWords, fmtDateTime } from '../../../shared/utils/currency.js';
import { logger } from '../../../shared/logger/index.js';

/* ── Resolve assets directory ── */
// Searched in order (audit fix #13):
//   1. Next to the compiled code — src/assets when running from source (tsx),
//      dist/assets in production (`npm run build` copies src/assets there).
//   2. <cwd>/src/assets — fallback for deployments that ship the source tree.
// The old code ONLY used <cwd>/src/assets, so a deploy that ships just dist/
// (or a PM2 config with a different cwd) silently lost the logo.
const ASSET_DIRS = [
  fileURLToPath(new URL('../../../assets/', import.meta.url)),
  path.join(process.cwd(), 'src', 'assets'),
];

/** The logo file actually present in src/assets (the old name had a typo). */
export const RECEIPT_LOGO_FILE = 'ucwithhinditext.png';

let missingLogoWarned = false;

/**
 * Load an asset image as a base64 data URI.
 * Called LAZILY inside renderReceipt() — not at module load time.
 * Returns '' when the file is missing, so the receipt falls back to a text
 * header instead of crashing — but now says so ONCE in the logs, rather
 * than silently shipping logo-less receipts forever.
 */
function loadImage(filename: string): string {
  for (const dir of ASSET_DIRS) {
    try {
      const buf = fs.readFileSync(path.join(dir, filename));
      const ext = path.extname(filename).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      // try the next directory
    }
  }
  if (!missingLogoWarned) {
    missingLogoWarned = true;
    logger.warn(
      { filename, searched: ASSET_DIRS },
      'receipt logo not found — receipts will use the text header. Did the build copy src/assets?',
    );
  }
  return '';
}

/** Shown wherever the payment record has no value — never an invented one. */
export const NOT_RECORDED = 'Not recorded';

/** Format an ISO timestamp, or NOT_RECORDED when absent / unparseable. */
function fmtMaybeDateTime(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return NOT_RECORDED;
  return fmtDateTime(iso);
}

/* ── Colours ── */
const C = {
  primary: '#1B5E37',
  primaryLight: '#2E7D52',
  primaryTint: '#E8F5EE',
  successGreen: '#4CAF50',
  pillGreen: '#E8F5EE',
  pillText: '#2E7D52',
  white: '#FFFFFF',
  offWhite: '#F8FAFB',
  textDark: '#1A1A2E',
  textMid: '#444',
  textLight: '#6B7280',
  border: '#E0E0E0',
  divider: '#EEEEEE',
  footerBg: '#1A2340',
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
  headerTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.textDark },
  headerRcptNo: { fontSize: 10, color: C.primary, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  headerDate: { fontSize: 8, color: C.textLight, marginTop: 3, textAlign: 'right' },
  headerComputer: { fontSize: 8, color: C.textLight, textAlign: 'right' },
  dividerLine: { height: 1, backgroundColor: C.border, marginHorizontal: 36, marginBottom: 20 },
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
  heroCheck: { fontSize: 24, color: C.white, fontFamily: 'Helvetica-Bold' },
  heroRight: { flex: 1 },
  heroTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.primaryLight, marginBottom: 4 },
  heroSub: { fontSize: 9.5, color: C.textMid, marginBottom: 1 },
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
  amtValue: { fontSize: 30, fontFamily: 'Helvetica-Bold', color: C.primary, marginBottom: 3 },
  amtWords: { fontSize: 8, color: C.textLight },
  amountDivider: { width: 1, height: 60, backgroundColor: C.border, marginHorizontal: 16 },
  amountRight: { alignItems: 'flex-end' },
  statusLabel: { fontSize: 9, color: C.textLight, marginBottom: 6 },
  statusPill: {
    backgroundColor: C.pillGreen,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 5,
  },
  statusPillText: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: C.pillText },
  section: { marginHorizontal: 36, marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: C.textDark, marginBottom: 10 },
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
  securityBold: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: C.textDark, marginBottom: 2 },
  securitySub: { fontSize: 8, color: C.textLight },
  thankYouArea: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginHorizontal: 36,
    marginBottom: 24,
  },
  thankYouLeft: {},
  thankYouTitle: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: C.primary, marginBottom: 3 },
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
  footerBar: {
    backgroundColor: C.footerBg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 14,
  },
  footerLeft: {},
  footerCompany: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.white, marginBottom: 2 },
  footerTagline: { fontSize: 7.5, color: '#9CA3AF' },
  footerWebsite: { fontSize: 9, color: '#9CA3AF' },
});

/* ── ReceiptData ── */

export type ReceiptData = {
  receiptNumber: string;
  paymentId: string;
  /** null → printed as "Not recorded" (never invented). */
  transactionId: string | null;
  /** null → printed as "Not recorded" (never invented). */
  paymentMethod: string | null;
  /** ISO timestamp of the payment; null → "Not recorded" (never "now"). */
  paymentEventAt: string | null;
  amount: number;
  travelDate: string;
  vehicleType: string;
  customerName: string;
  generatedAt: string;
};

/* ── Document component ── */

export const ReceiptDocument: React.FC<{ data: ReceiptData; logoUri: string }> = ({
  data,
  logoUri,
}) => (
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
          {logoUri ? (
            <Image style={s.logo} src={logoUri} />
          ) : (
            <Text style={{ fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.primary }}>
              Urban Cruise
            </Text>
          )}
        </View>
        <View style={s.headerRight}>
          <Text style={s.headerTitle}>Payment Receipt</Text>
          <Text style={s.headerRcptNo}>#{data.receiptNumber}</Text>
          <Text style={s.headerDate}>Generated on: {fmtDateTime(data.generatedAt)}</Text>
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
          <Text style={s.tableValue}>{data.paymentMethod ?? NOT_RECORDED}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Payment ID</Text>
          <Text style={s.tableValueGreen}>{data.paymentId}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Transaction ID</Text>
          <Text style={s.tableValueGreen}>{data.transactionId ?? NOT_RECORDED}</Text>
        </View>
        <View style={s.tableRow}>
          <Text style={s.tableLabel}>Paid On</Text>
          <Text style={s.tableValue}>{fmtMaybeDateTime(data.paymentEventAt)}</Text>
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

/**
 * Render a receipt PDF to a Buffer.
 *
 * Image loading happens HERE, not at module load time (DIP fix).
 * Importing this module no longer touches the filesystem — safe in tests
 * and during container cold-starts where src/assets may be absent.
 */
export async function renderReceipt(data: ReceiptData): Promise<Buffer> {
  const { renderToBuffer } = await import('@react-pdf/renderer');
  // Lazy: load image only when an actual render is requested.
  const logoUri = loadImage(RECEIPT_LOGO_FILE);
  const element = <ReceiptDocument data={data} logoUri={logoUri} />;
  return renderToBuffer(element);
}
