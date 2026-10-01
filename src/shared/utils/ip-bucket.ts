/**
 * ==============================================================================
 * IP → subnet-bucket helpers (SMS-pumping / abuse-limit buckets)
 * ==============================================================================
 * bucketIp(ip)
 *   IPv4 → /24 key ("v4:a.b.c")
 *   IPv6 → /64 key ("v6:xxxx:xxxx:xxxx:xxxx")
 *   null | unparseable → null (caller must skip the check — fail-open)
 *
 * WHY /24 AND /64:
 *   Legitimate corporate NAT / campus / coworking traffic shares a small
 *   IPv4 subnet, so /24 is coarse enough not to false-positive on the good
 *   guys while still catching attackers behind a small VPN pool. RFC 6177
 *   defines /64 as the standard end-site allocation for IPv6.
 *
 * Extracted from src/modules/auth/service.ts (formerly ~lines 970-1015).
 * Kept UNIT-testable: no Redis / no logger / no DB — pure functions of a
 * string in and a string out.
 * ==============================================================================
 */
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Reduce a client IP to a coarse anti-abuse bucket key.
 * Returns null when the IP is missing or unparseable so the caller can
 * skip the corresponding rate-limit check (fail-open on infra noise —
 * per-mobile limits still apply).
 */
export function bucketIp(ip: string | null): string | null {
  if (!ip) return null;
  // Node hands us IPv4-mapped IPv6 (::ffff:x.x.x.x) on dual-stack sockets —
  // unwrap so the IPv4 branch handles it.
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
 * Take the first four hextets of an IPv6 address (the /64 network portion).
 * Handles `::` compression by expanding to eight groups first, then slicing.
 * Padded to four-hex per hextet so equivalent addresses hash to the same key
 * regardless of how the client wrote them (2001:db8:: and 2001:0db8:0:0::
 * are the same network).
 *
 * Exported so tests can hit it directly.
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
