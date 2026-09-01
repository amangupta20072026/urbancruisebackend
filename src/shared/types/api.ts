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

/** Page envelope for list endpoints. */
export type Paginated<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  hasNext: boolean;
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
