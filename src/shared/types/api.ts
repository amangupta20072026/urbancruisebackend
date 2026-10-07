/**
 * ==============================================================================
 * API response envelopes
 * ==============================================================================
 * The RN app's axios interceptors expect these shapes. Never invent a new
 * envelope per endpoint — every route returns one of these.
 * ==============================================================================
 */

/** Success envelope for a single resource / arbitrary payload. */
export type ApiResponse<T> = {
  data: T;
  requestId: string;
};

/**
 * Optional, endpoint-specific facts about the WHOLE list (not about one
 * item), e.g. the inbox's `unreadCount` for the app's badge. Lives under
 * `meta` so the page envelope keeps one fixed shape for every endpoint —
 * clients that don't need it simply ignore the key.
 */
export type PageMeta = Record<string, string | number | boolean | null>;

/** Page envelope for list endpoints. `meta` is present only when the
 *  endpoint supplies it. */
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
