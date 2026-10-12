// Rupee and date formatting for display (used by the payment receipt).

/** 123456 → "₹1,23,456" */
export function formatRupees(n: number): string {
  return `\u20B9${n.toLocaleString('en-IN')}`;
}

/**
 * 123456 → "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only".
 * Paise are dropped. Returns '' for negative or non-finite values.
 */
export function rupeesToWords(amount: number): string {
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
    const h = Math.floor(x / 100);
    const r = x % 100;
    const p: string[] = [];
    if (h) p.push(`${ones[h] ?? ''} Hundred`);
    if (r) p.push(two(r));
    return p.join(' ');
  };

  const cr = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thou = Math.floor((n % 100_000) / 1_000);
  const rem = n % 1_000;

  const p: string[] = [];
  if (cr) p.push(`${two(cr)} Crore`);
  if (lakh) p.push(`${two(lakh)} Lakh`);
  if (thou) p.push(`${two(thou)} Thousand`);
  if (rem) p.push(three(rem));

  return `Rupees ${p.join(' ')} Only`;
}

/**
 * ISO date-time → e.g. "12 Jan 2025, 10:15 am" (en-IN format).
 * Uses the server's timezone (no timeZone option is set).
 */
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
