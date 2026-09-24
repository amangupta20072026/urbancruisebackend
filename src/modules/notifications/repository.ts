/**
 * ==============================================================================
 * notifications — repository (SQL only)
 * ==============================================================================
 * EVERY query scopes by (role, entity_id) to enforce tenant isolation.
 * Prepared statements (pool.execute) prevent SQL injection.
 *
 * mysql2 pool.execute<T> requires T to extend RowDataPacket | ResultSetHeader
 * etc. Row types are intersected with RowDataPacket (the pattern used in
 * src/modules/auth/repository.ts throughout this codebase).
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../shared/db/pool.js';
import type { UserRole } from '../../shared/rbac/roles.js';
import type {
  PushTokenRow,
  NotificationRow,
  NotificationCategory,
  CreateNotificationInput,
} from './types.js';

/* ==========================================================================
 * push_tokens
 * ========================================================================== */

/**
 * Upsert an FCM token for a (role, entity_id, device_id) triple.
 * ON DUPLICATE KEY UPDATE keeps the latest token and timestamp.
 * Per Firebase's token management guide:
 *   https://firebase.google.com/docs/cloud-messaging/manage-tokens
 */
export async function upsertPushToken(params: {
  role: UserRole;
  entityId: number;
  deviceId: string;
  fcmToken: string;
  platform: 'ios' | 'android';
  deviceName?: string;
  appVersion?: string;
}): Promise<void> {
  await pool.execute(
    `INSERT INTO push_tokens
       (role, entity_id, device_id, fcm_token, platform, device_name, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       fcm_token   = VALUES(fcm_token),
       platform    = VALUES(platform),
       device_name = VALUES(device_name),
       app_version = VALUES(app_version),
       updated_at  = CURRENT_TIMESTAMP`,
    [
      params.role,
      params.entityId,
      params.deviceId,
      params.fcmToken,
      params.platform,
      params.deviceName ?? null,
      params.appVersion ?? null,
    ],
  );
}

/**
 * Hard-delete a token by (role, entity_id, device_id).
 * Called on logout — after this, FCM will not push to this device for this user.
 */
export async function deletePushToken(params: {
  role: UserRole;
  entityId: number;
  deviceId: string;
}): Promise<void> {
  await pool.execute(
    `DELETE FROM push_tokens
     WHERE role = ? AND entity_id = ? AND device_id = ?`,
    [params.role, params.entityId, params.deviceId],
  );
}

/**
 * Load all FCM tokens for a given (role, entity_id).
 * Used by the push-dispatch layer to fan out to all active devices.
 */
type PushTokenDbRow = RowDataPacket & PushTokenRow;

export async function getTokensForEntity(params: {
  role: UserRole;
  entityId: number;
}): Promise<PushTokenRow[]> {
  const [rows] = await pool.execute<PushTokenDbRow[]>(
    `SELECT * FROM push_tokens WHERE role = ? AND entity_id = ?`,
    [params.role, params.entityId],
  );
  return rows;
}

/**
 * Bulk-delete stale/invalid FCM tokens by their token string.
 * Called after FCM returns messaging/registration-token-not-registered.
 * Per: https://firebase.google.com/docs/cloud-messaging/manage-tokens#detect-invalid-token-responses
 *
 * Chunked at 100 tokens per call to stay within MySQL's IN() limits.
 */
export async function deleteStalePushTokens(fcmTokens: string[]): Promise<void> {
  if (fcmTokens.length === 0) return;
  const CHUNK = 100;
  for (let i = 0; i < fcmTokens.length; i += CHUNK) {
    const chunk = fcmTokens.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    await pool.execute(`DELETE FROM push_tokens WHERE fcm_token IN (${placeholders})`, chunk);
  }
}

/* ==========================================================================
 * notifications inbox
 * ========================================================================== */

/**
 * Insert one notification row and return its uuid.
 */
export async function insertNotification(input: CreateNotificationInput): Promise<string> {
  const payloadJson = input.payload ? JSON.stringify(input.payload) : null;

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO notifications
       (role, entity_id, kind, category, title, body, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.role, input.entityId, input.kind, input.category, input.title, input.body, payloadJson],
  );

  type UuidRow = RowDataPacket & { uuid: string };
  const [uuidRows] = await pool.execute<UuidRow[]>(`SELECT uuid FROM notifications WHERE id = ?`, [
    result.insertId,
  ]);

  const first = uuidRows[0];
  if (!first) throw new Error('notifications: insertNotification — uuid fetch returned no rows');
  return first.uuid;
}

/**
 * Back-fill the FCM message ID after a successful send. Best-effort.
 */
export async function updateNotificationFcmId(params: {
  uuid: string;
  fcmMessageId: string;
}): Promise<void> {
  await pool.execute(`UPDATE notifications SET fcm_message_id = ? WHERE uuid = ?`, [
    params.fcmMessageId,
    params.uuid,
  ]);
}

/**
 * List notifications for a user, newest first, with optional filters.
 */
type NotificationDbRow = RowDataPacket & NotificationRow;
type CountRow = RowDataPacket & { total: number };
type UnreadCountRow = RowDataPacket & { unread_count: number };

export async function listNotifications(params: {
  role: UserRole;
  entityId: number;
  page: number;
  pageSize: number;
  category?: NotificationCategory;
  unreadOnly?: boolean;
}): Promise<{ rows: NotificationRow[]; total: number; unreadCount: number }> {
  const conditions: string[] = ['role = ?', 'entity_id = ?'];
  const args: (string | number | boolean | null)[] = [params.role, params.entityId];

  if (params.category !== undefined) {
    conditions.push('category = ?');
    args.push(params.category);
  }
  if (params.unreadOnly === true) {
    conditions.push('read_at IS NULL');
  }

  const where = conditions.join(' AND ');
  const offset = (params.page - 1) * params.pageSize;

  const [rows] = await pool.execute<NotificationDbRow[]>(
    `SELECT * FROM notifications WHERE ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, params.pageSize, offset],
  );

  const [countRows] = await pool.execute<CountRow[]>(
    `SELECT COUNT(*) AS total FROM notifications WHERE ${where}`,
    args,
  );

  // Unread count scoped to entity, optionally filtered by category
  const unreadConditions = ['role = ?', 'entity_id = ?', 'read_at IS NULL'];
  const unreadArgs: (string | number | boolean | null)[] = [params.role, params.entityId];
  if (params.category !== undefined) {
    unreadConditions.push('category = ?');
    unreadArgs.push(params.category);
  }
  const [unreadRows] = await pool.execute<UnreadCountRow[]>(
    `SELECT COUNT(*) AS unread_count FROM notifications
     WHERE ${unreadConditions.join(' AND ')}`,
    unreadArgs,
  );

  return {
    rows,
    total: countRows[0]?.total ?? 0,
    unreadCount: unreadRows[0]?.unread_count ?? 0,
  };
}

/**
 * Mark a single notification as read. Scoped to (role, entity_id).
 * Returns true if the row was updated (was unread and owned by this entity).
 */
export async function markNotificationRead(params: {
  uuid: string;
  role: UserRole;
  entityId: number;
}): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE notifications
     SET read_at = CURRENT_TIMESTAMP
     WHERE uuid = ? AND role = ? AND entity_id = ? AND read_at IS NULL`,
    [params.uuid, params.role, params.entityId],
  );
  return result.affectedRows > 0;
}

/**
 * Mark ALL unread notifications as read for an entity.
 */
export async function markAllNotificationsRead(params: {
  role: UserRole;
  entityId: number;
}): Promise<void> {
  await pool.execute(
    `UPDATE notifications
     SET read_at = CURRENT_TIMESTAMP
     WHERE role = ? AND entity_id = ? AND read_at IS NULL`,
    [params.role, params.entityId],
  );
}
