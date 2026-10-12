/**
 * Receipt PDF template (@react-pdf/renderer). Purely presentational; amount
 * formatting lives in shared/utils/currency.ts.
 *
 * Embeds Noto Sans (OFL, see src/assets/fonts/OFL.txt) because Helvetica has
 * no ₹ glyph; without the font files it falls back to Helvetica and prints
 * "Rs.". Icons are drawn with <Svg> so they don't depend on any font.
 * No QR code: add one only together with a real verification endpoint.
 * Assets are loaded inside renderReceipt(), never at import time.
 */

import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Document,
  Page,
  Text,
  View,
  Image,
  StyleSheet,
  Font,
  Svg,
  Path,
  Rect,
} from '@react-pdf/renderer';
import { formatRupees, rupeesToWords, fmtDateTime } from '../../../shared/utils/currency.js';
import { logger } from '../../../shared/logger/index.js';

// Asset folders, searched in order: next to the running code (src/assets
// under tsx, dist/assets after build), then <cwd>/src/assets.
const ASSET_DIRS = [
  fileURLToPath(new URL('../../../assets/', import.meta.url)),
  path.join(process.cwd(), 'src', 'assets'),
];

/** Logo file in the assets folder. */
export const RECEIPT_LOGO_FILE = 'ucwithhinditext.png';

/** Font files in the assets folder; must include the ₹ glyph. */
const FONT_FILES = {
  regular: path.join('fonts', 'NotoSans-Regular.ttf'),
  bold: path.join('fonts', 'NotoSans-Bold.ttf'),
} as const;

/** Font family used when Noto Sans is available. */
export const RECEIPT_FONT_FAMILY = 'NotoSans';
/** Built-in fallback; has no ₹ glyph, so amounts use "Rs.". */
const FALLBACK_FONT_FAMILY = 'Helvetica';

/** First existing path for `relative` across ASSET_DIRS, or null. */
function findAsset(relative: string): string | null {
  for (const dir of ASSET_DIRS) {
    const full = path.join(dir, relative);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

let missingLogoWarned = false;

/**
 * Loads an image as a base64 data URI. Returns '' if missing (the header
 * falls back to text) and logs that once.
 */
function loadImage(filename: string): string {
  const full = findAsset(filename);
  if (full) {
    const buf = fs.readFileSync(full);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
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

/** Registers Noto Sans on first use. Returns true if available; cached, logs a miss once. */
let fontState: 'unknown' | 'ready' | 'missing' = 'unknown';

function ensureReceiptFont(): boolean {
  if (fontState !== 'unknown') return fontState === 'ready';

  const regular = findAsset(FONT_FILES.regular);
  const bold = findAsset(FONT_FILES.bold);
  if (!regular || !bold) {
    fontState = 'missing';
    logger.warn(
      { files: FONT_FILES, searched: ASSET_DIRS },
      'receipt font not found — falling back to Helvetica (amounts print as "Rs."). Did the build copy src/assets?',
    );
    return false;
  }

  Font.register({
    family: RECEIPT_FONT_FAMILY,
    fonts: [
      { src: regular, fontWeight: 'normal' },
      { src: bold, fontWeight: 'bold' },
    ],
  });
  fontState = 'ready';
  return true;
}

/** Printed when the payment record has no value. Never invent one. */
export const NOT_RECORDED = 'Not recorded';

/** Formats an ISO timestamp, or NOT_RECORDED if missing or invalid. */
function fmtMaybeDateTime(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return NOT_RECORDED;
  return fmtDateTime(iso);
}

/** "₹12,345" with Noto Sans, "Rs. 12,345" with the Helvetica fallback. */
export function formatReceiptAmount(n: number, hasRupeeGlyph: boolean): string {
  return hasRupeeGlyph ? formatRupees(n) : `Rs. ${n.toLocaleString('en-IN')}`;
}

/* Colours */
const C = {
  primary: '#1B5E37',
  primaryLight: '#2E7D52',
  primaryTint: '#E8F5EE',
  successGreen: '#4CAF50',
  pillGreen: '#E8F5EE',
  pillText: '#2E7D52',
  white: '#FFFFFF',
  textDark: '#1A1A2E',
  textMid: '#444',
  textLight: '#6B7280',
  border: '#E0E0E0',
  divider: '#EEEEEE',
  footerBg: '#1A2340',
};

Font.registerHyphenationCallback(word => [word]);

/*
 * Styles. The font family is set once on <Page> and inherited; fontWeight
 * 'bold' maps to the matching bold face.
 */
const s = StyleSheet.create({
  page: {
    backgroundColor: C.white,
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
  logoText: { fontSize: 18, fontWeight: 'bold', color: C.primary },
  headerRight: { alignItems: 'flex-end' },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: C.textDark },
  headerRcptNo: { fontSize: 10, color: C.primary, fontWeight: 'bold', marginTop: 3 },
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
  heroRight: { flex: 1 },
  heroTitle: { fontSize: 18, fontWeight: 'bold', color: C.primaryLight, marginBottom: 4 },
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
  amountLeft: { flex: 1 },
  amtLabel: { fontSize: 9, color: C.textLight, marginBottom: 5 },
  amtValue: { fontSize: 30, fontWeight: 'bold', color: C.primary, marginBottom: 3 },
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
  statusPillText: { fontSize: 11, fontWeight: 'bold', color: C.pillText },
  section: { marginHorizontal: 36, marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: 'bold', color: C.textDark, marginBottom: 10 },
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
    fontWeight: 'bold',
    textAlign: 'right',
    maxWidth: '60%',
  },
  tableValueGreen: {
    fontSize: 9.5,
    color: C.primary,
    fontWeight: 'bold',
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
  securityText: { flex: 1 },
  securityBold: { fontSize: 8.5, fontWeight: 'bold', color: C.textDark, marginBottom: 2 },
  securitySub: { fontSize: 8, color: C.textLight },
  thankYouArea: {
    marginHorizontal: 36,
    marginBottom: 24,
  },
  thankYouTitle: { fontSize: 13, fontWeight: 'bold', color: C.primary, marginBottom: 3 },
  thankYouSub: { fontSize: 8.5, color: C.textLight },
  footerBar: {
    backgroundColor: C.footerBg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 36,
    paddingVertical: 14,
  },
  footerCompany: { fontSize: 9, fontWeight: 'bold', color: C.white, marginBottom: 2 },
  footerTagline: { fontSize: 7.5, color: '#9CA3AF' },
  footerWebsite: { fontSize: 9, color: '#9CA3AF' },
});

/* Icons, drawn as vectors */

/** White check mark. */
const CheckIcon: React.FC = () => (
  <Svg width={26} height={26} viewBox="0 0 24 24">
    <Path
      d="M5 12.5 L10 17.5 L19 7"
      stroke={C.white}
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </Svg>
);

/** White padlock with keyhole. */
const LockIcon: React.FC = () => (
  <Svg width={16} height={16} viewBox="0 0 24 24">
    <Path
      d="M7 11 V7.5 A5 5 0 0 1 17 7.5 V11"
      stroke={C.white}
      strokeWidth={2.4}
      strokeLinecap="round"
      fill="none"
    />
    <Rect x={4} y={11} width={16} height={11} rx={2} ry={2} fill={C.white} />
    <Rect x={11} y={14.5} width={2} height={4} rx={1} ry={1} fill={C.primaryLight} />
  </Svg>
);

/* Receipt data */

export type ReceiptData = {
  receiptNumber: string;
  paymentId: string;
  /** null prints as "Not recorded". */
  transactionId: string | null;
  /** null prints as "Not recorded". */
  paymentMethod: string | null;
  /** ISO payment time; null prints as "Not recorded" (never "now"). */
  paymentEventAt: string | null;
  amount: number;
  travelDate: string;
  vehicleType: string;
  customerName: string;
  generatedAt: string;
};

/* Document */

export const ReceiptDocument: React.FC<{
  data: ReceiptData;
  logoUri: string;
  /** Font family for the whole page. */
  fontFamily: string;
  /** True when the font has a ₹ glyph. */
  hasRupeeGlyph: boolean;
}> = ({ data, logoUri, fontFamily, hasRupeeGlyph }) => (
  <Document
    title={`Urban Cruise Receipt – ${data.receiptNumber}`}
    author="Urban Cruise"
    subject="Payment Receipt"
    creator="Urban Cruise Backend"
    producer="@react-pdf/renderer"
  >
    <Page size="A4" style={[s.page, { fontFamily }]}>
      {/* Header: logo left, receipt info right */}
      <View style={s.headerArea}>
        <View>
          {logoUri ? (
            <Image style={s.logo} src={logoUri} />
          ) : (
            <Text style={s.logoText}>Urban Cruise</Text>
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

      {/* Hero: drawn check mark + Payment Successful */}
      <View style={s.heroBanner}>
        <View style={s.heroCircle}>
          <CheckIcon />
        </View>
        <View style={s.heroRight}>
          <Text style={s.heroTitle}>Payment Successful</Text>
          <Text style={s.heroSub}>Your payment has been completed successfully.</Text>
          <Text style={s.heroSub}>Thank you for choosing Urban Cruise.</Text>
        </View>
      </View>

      {/* Amount card */}
      <View style={s.amountCard}>
        <View style={s.amountLeft}>
          <Text style={s.amtLabel}>Amount Paid</Text>
          <Text style={s.amtValue}>{formatReceiptAmount(data.amount, hasRupeeGlyph)}</Text>
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

      {/* Payment Details */}
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

      {/* Security banner */}
      <View style={s.securityBanner}>
        <View style={s.lockCircle}>
          <LockIcon />
        </View>
        <View style={s.securityText}>
          <Text style={s.securityBold}>
            This payment was processed securely using an encrypted connection.
          </Text>
          <Text style={s.securitySub}>Your payment information is safe with us.</Text>
        </View>
      </View>

      {/* Thank you */}
      <View style={s.thankYouArea}>
        <Text style={s.thankYouTitle}>Thank you for choosing Urban Cruise!</Text>
        <Text style={s.thankYouSub}>Safe Journeys. A Better Tomorrow.</Text>
      </View>

      {/* Dark footer bar */}
      <View style={s.footerBar}>
        <View>
          <Text style={s.footerCompany}>Urban Cruise Mobiliry Solutions Private Limited</Text>
          <Text style={s.footerTagline}>India's Trusted Travel Partner</Text>
        </View>
        <Text style={s.footerWebsite}>www.urbancruise.in</Text>
      </View>
    </Page>
  </Document>
);

/** Renders a receipt PDF to a Buffer. Loads images and fonts on demand. */
export async function renderReceipt(data: ReceiptData): Promise<Buffer> {
  const { renderToBuffer } = await import('@react-pdf/renderer');
  const hasRupeeGlyph = ensureReceiptFont();
  const logoUri = loadImage(RECEIPT_LOGO_FILE);
  const element = (
    <ReceiptDocument
      data={data}
      logoUri={logoUri}
      fontFamily={hasRupeeGlyph ? RECEIPT_FONT_FAMILY : FALLBACK_FONT_FAMILY}
      hasRupeeGlyph={hasRupeeGlyph}
    />
  );
  return renderToBuffer(element);
}
