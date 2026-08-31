/**
 * ==============================================================================
 * Common Zod schemas
 * ==============================================================================
 * Reusable pieces every module composes into request-body / query schemas.
 * ==============================================================================
 */
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants.js';

/** UUID v4 (upper- or lower-case) — matches crypto.randomUUID output. */
export const UuidSchema = z.string().uuid();

/** Loose ID string — some legacy tables use non-UUID keys. */
export const IdSchema = z.string().min(1).max(64);

/** ISO 8601 datetime. */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * India phone in E.164 (e.g. +919812345678). Backend-only; when we add
 * libphonenumber-js later, replace with a proper parse+validate.
 */
export const PhoneSchema = z.string().regex(/^\+91[6-9]\d{9}$/, 'invalid Indian mobile number');

export const EmailSchema = z.email().max(254);

/** Pagination query params — `page` 1-based, `pageSize` capped by constants. */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof PaginationSchema>;
