/**
 * notifications types. Rows use DB column names; DTOs are what the API returns.
 * NotificationKind and NotificationCategory must match the app's
 * src/features/shared/notifications/types.ts.
 */
import type { UserRole } from '../../shared/rbac/roles.js';

/* push_tokens row */

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

/* notifications row */

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
  /** DeepLinkTarget JSON, or null. */
  payload: Record<string, unknown> | null;
  fcm_message_id: string | null;
  read_at: Date | null;
  created_at: Date;
};

/* Response DTOs */

export type NotificationDto = {
  id: string; // uuid
  kind: NotificationKind;
  category: NotificationCategory;
  title: string;
  body: string;
  /** DeepLinkTarget for the app's resolveFcmClick(); null means no tap action. */
  payload: Record<string, unknown> | null;
  unread: boolean;
  timestamp: string; // ISO 8601
};

export type NotificationListDto = {
  items: NotificationDto[];
  total: number;
  unreadCount: number;
};

/* Input for sendNotification (used by other modules) */

export type CreateNotificationInput = {
  role: UserRole;
  entityId: number;
  kind: NotificationKind;
  category: NotificationCategory;
  title: string;
  body: string;
  /** DeepLinkTarget opened on tap, e.g. { kind: 'customer.bookingDetail', bookingId: '…' }. */
  payload?: Record<string, unknown>;
};

/* Push dispatch result */

export type PushDispatchResult = {
  /** Number of tokens that accepted the message. */
  successCount: number;
  /** Invalid tokens to delete from push_tokens. */
  tokensToDelete: string[];
};
