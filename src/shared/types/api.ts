/**
 * Response envelopes. Every endpoint returns one of these shapes; the mobile
 * app depends on them.
 */

/** Single-item success response. */
export type ApiResponse<T> = {
  data: T;
  requestId: string;
};

/** Facts about the whole list, e.g. the inbox unreadCount. */
export type PageMeta = Record<string, string | number | boolean | null>;

/** Paginated list response. */
export type Paginated<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
  meta?: PageMeta;
  requestId: string;
};

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};
