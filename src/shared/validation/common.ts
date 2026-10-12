// Reusable Zod schemas for request validation.
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants.js';

export const UuidSchema = z.uuid();

/** Non-UUID ids. */
export const IdSchema = z.string().min(1).max(64);

/** ISO 8601 datetime; a timezone offset is allowed. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Indian mobile in E.164, e.g. +919812345678. */
export const PhoneSchema = z.string().regex(/^\+91[6-9]\d{9}$/, 'invalid Indian mobile number');

export const EmailSchema = z.email().max(254);

/** page starts at 1; pageSize is capped at MAX_PAGE_SIZE. */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type Pagination = z.infer<typeof PaginationSchema>;
