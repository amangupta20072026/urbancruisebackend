/**
 * ==============================================================================
 * ID generation
 * ==============================================================================
 * Node 24 ships `crypto.randomUUID()` (RFC 4122 v4). Faster than any userspace
 * uuid package, zero deps. Use for correlation IDs, event IDs, anything where
 * uniqueness > sortability.
 *
 * For DB rows where sortable IDs help (time-ordered pagination), consider
 * ULID / UUID v7 later — Node 24 doesn't ship v7 natively yet.
 * ==============================================================================
 */
import { randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();
