/**
 * ==============================================================================
 * notifications.service — inbox management
 * ==============================================================================
 * Owns the read-side of the `notifications` table:
 *   listNotifications    — paginated inbox with optional category + unread filters.
 *   markNotificationRead — mark one notification row as read (scoped by entity).
 *   markAllRead          — bulk-mark all unread rows as read for an entity.
 *
 * SRP: this file knows only about inbox state. It has no knowledge of token
 * lifecycle, push dispatch, or the mechanics of persisting a new notification.
 * ==============================================================================
 */
import * as repo from './repository.js';
import type { UserRole } from '../../shared/rbac/roles.js';
import type { NotificationDto, NotificationListDto, NotificationRow } from './types.js';

export async function listNotifications(params: {
  role: UserRole;
  entityId: number;
  page: number;
  pageSize: number;
  category?: 'quote' | 'booking' | 'payment' | 'general';
  unreadOnly?: boolean;
}): Promise<NotificationListDto> {
  const { rows, total, unreadCount } = await repo.listNotifications(params);
  return {
    items: rows.map(rowToDto),
    total,
    unreadCount,
  };
}

export async function markNotificationRead(params: {
  uuid: string;
  role: UserRole;
  entityId: number;
}): Promise<void> {
  await repo.markNotificationRead(params);
}

export async function markAllRead(params: { role: UserRole; entityId: number }): Promise<void> {
  await repo.markAllNotificationsRead(params);
}

/* --------------------------------------------------------------------------
 * Local helper — NotificationRow → NotificationDto projection
 * -------------------------------------------------------------------------- */
function rowToDto(row: NotificationRow): NotificationDto {
  return {
    id: row.uuid,
    kind: row.kind,
    category: row.category,
    title: row.title,
    body: row.body,
    payload: row.payload,
    unread: row.read_at === null,
    timestamp: row.created_at.toISOString(),
  };
}
