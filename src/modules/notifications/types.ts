/**
 * ==============================================================================
 * notifications — types (DB rows + DTOs)
 * ==============================================================================
 * Row types map directly to DB column names (snake_case).
 * DTOs are what the API returns to the client (camelCase, no DB internals).
 *
 * `NotificationKind` and `NotificationCategory` are shared with the frontend's
 * src/features/shared/notifications/types.ts — keep them in sync manually
 * when adding new kinds.
 * ==============================================================================
 */
import type { UserRole } from '../../shared/rbac/roles.js';

/* --------------------------------------------------------------------------
 * DB Row — push_tokens
 * -------------------------------------------------------------------------- */

export type PushTokenRow = {
  id: number;
  role: UserRole;
  entity_id: number;
  device_id: string;
  fcm_token: string;
  platform: 'ios' | 'android';
  device_name: string | null;
  app_version: string | null;
  created_at: Date;
  updated_at: Date;
};

/* --------------------------------------------------------------------------
 * DB Row — notifications
 * -------------------------------------------------------------------------- */

export type NotificationCategory = 'quote' | 'booking' | 'payment' | 'general';

export type NotificationKind =
  | 'quotation_ready'
  | 'quotation_update'
  | 'trip_confirmed'
  | 'driver_assigned'
  | 'payment_success'
  | 'welcome'
  | 'promo'
  | 'app_update';

export type NotificationRow = {
  id: number;
  uuid: string;
  role: UserRole;
  entity_id: number;
  kind: NotificationKind;
  category: NotificationCategory;
  title: string;
  body: string;
  /** JSON DeepLinkTarget or null */
  payload: Record<string, unknown> | null;
  fcm_message_id: string | null;
  read_at: Date | null;
  created_at: Date;
};

/* --------------------------------------------------------------------------
 * DTOs — returned to client
 * -------------------------------------------------------------------------- */

export type NotificationDto = {
  id: string; // uuid
  kind: NotificationKind;
  category: NotificationCategory;
  title: string;
  body: string;
  /** Serialized DeepLinkTarget for the frontend's resolveFcmClick. Null means no tap action. */
  payload: Record<string, unknown> | null;
  unread: boolean;
  timestamp: string; // ISO 8601
};

export type NotificationListDto = {
  items: NotificationDto[];
  total: number;
  unreadCount: number;
};

/* --------------------------------------------------------------------------
 * Internal — payload shape for createNotification (called from other modules)
 * -------------------------------------------------------------------------- */

export type CreateNotificationInput = {
  role: UserRole;
  entityId: number;
  kind: NotificationKind;
  category: NotificationCategory;
  title: string;
  body: string;
  /**
   * A DeepLinkTarget object (discriminated union from the deeplink catalog).
   * e.g. { kind: 'customer.bookingDetail', bookingId: 'BKG-123' }
   * The client passes this through resolveFcmClick() on tap.
   */
  payload?: Record<string, unknown>;
};

/* --------------------------------------------------------------------------
 * Push dispatch result — returned from the FCM send layer
 * -------------------------------------------------------------------------- */

export type PushDispatchResult = {
  /** Number of tokens that accepted the message. */
  successCount: number;
  /** Tokens that failed and should be pruned from push_tokens. */
  tokensToDelete: string[];
};
