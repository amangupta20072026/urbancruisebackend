/**
 * notifications repository. Every query is scoped by (role, entity_id).
 * Row types intersect RowDataPacket, as pool.execute<T> requires.
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { pool } from '../../shared/db/pool.js';
import { withTransaction } from '../../shared/db/transaction.js';
import type { UserRole } from '../../shared/rbac/roles.js';
import type {
  PushTokenRow,
  NotificationRow,
  NotificationCategory,
  CreateNotificationInput,
} from './types.js';

/* push_tokens */

/**
 * Upserts the token for (role, entity_id, device_id) and claims it: in the
 * same transaction, any other row holding this token is deleted. A token
 * identifies one app install, so this stops a phone receiving a previous
 * account's notifications after a new login.
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
  await withTransaction(async conn => {
    await conn.execute(
      `DELETE FROM push_tokens
        WHERE fcm_token = ?
          AND NOT (role = ? AND entity_id = ? AND device_id = ?)`,
      [params.fcmToken, params.role, params.entityId, params.deviceId],
    );
    await conn.execute(
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
  });
}

/** Deletes the token for (role, entity_id, device_id). Used on logout. */
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

/** All tokens for (role, entity_id), one per device. */
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

/** Deletes tokens FCM reported as invalid, 100 per query. */
export async function deleteStalePushTokens(fcmTokens: string[]): Promise<void> {
  if (fcmTokens.length === 0) return;
  const CHUNK = 100;
  for (let i = 0; i < fcmTokens.length; i += CHUNK) {
    const chunk = fcmTokens.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    await pool.execute(`DELETE FROM push_tokens WHERE fcm_token IN (${placeholders})`, chunk);
  }
}

/* notifications inbox */

/** Inserts a notification and returns its uuid. */
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

/** Stores the FCM message id after a send. Best-effort. */
export async function updateNotificationFcmId(params: {
  uuid: string;
  fcmMessageId: string;
}): Promise<void> {
  await pool.execute(`UPDATE notifications SET fcm_message_id = ? WHERE uuid = ?`, [
    params.fcmMessageId,
    params.uuid,
  ]);
}

/** Inbox page, newest first, with optional category and unread filters. */
type NotificationDbRow = RowDataPacket & NotificationRow;
// COUNT(*) comes back as a string (pool uses bigNumberStrings); safe to Number().
type CountRow = RowDataPacket & { total: string | number };
type UnreadCountRow = RowDataPacket & { unread_count: string | number };

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

  // Unread count respects category but not the unread filter or paging.
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
    total: Number(countRows[0]?.total ?? 0),
    unreadCount: Number(unreadRows[0]?.unread_count ?? 0),
  };
}

/** Marks one notification read. True if an unread row owned by this entity was updated. */
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

/** Marks all of an entity's notifications read. */
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
