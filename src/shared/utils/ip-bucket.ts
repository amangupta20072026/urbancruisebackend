/**
 * Groups client IPs into network buckets for the OTP abuse limits:
 * IPv4 → /24 ("v4:a.b.c"), IPv6 → /64 ("v6:xxxx:xxxx:xxxx:xxxx").
 * IPv4 /24 catches small VPN or server ranges; an IPv6 /64 is usually one
 * mobile device. Keep the /64 equal to IPV6_RATE_LIMIT_SUBNET.
 */
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Returns the bucket key, or null for a missing/invalid IP (the caller then
 * skips the IP check; per-mobile limits still apply).
 */
export function bucketIp(ip: string | null): string | null {
  if (!ip) return null;
  // Treat IPv4-mapped IPv6 (::ffff:a.b.c.d) as IPv4.
  const stripped = ip.replace(/^::ffff:/, '');
  if (isIPv4(stripped)) {
    const [a, b, c] = stripped.split('.');
    return `v4:${a}.${b}.${c}`;
  }
  if (isIPv6(ip)) {
    return `v6:${ipv6First64(ip)}`;
  }
  return null;
}

/**
 * First four groups (/64) of an IPv6 address, expanded and zero-padded so
 * different spellings of the same network give the same key.
 */
export function ipv6First64(ip: string): string {
  const parts = ip.split(':');
  const emptyIdx = parts.indexOf('');
  let expanded: string[];
  if (emptyIdx === -1) {
    expanded = parts;
  } else {
    const before = parts.slice(0, emptyIdx).filter(p => p !== '');
    const after = parts.slice(emptyIdx + 1).filter(p => p !== '');
    const zerosNeeded = 8 - before.length - after.length;
    expanded = [...before, ...Array(Math.max(zerosNeeded, 0)).fill('0'), ...after];
  }
  while (expanded.length < 8) expanded.push('0');
  return expanded
    .slice(0, 4)
    .map(p => p.padStart(4, '0').toLowerCase())
    .join(':');
}
