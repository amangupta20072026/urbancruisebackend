/**
 * ==============================================================================
 * notifications — Zod schemas (validated request shapes)
 * ==============================================================================
 */
import { z } from 'zod';

/* --------------------------------------------------------------------------
 * POST /notifications/tokens  — register FCM token
 * -------------------------------------------------------------------------- */

export const RegisterTokenBody = z.object({
  token: z.string().min(10).max(4096),
  deviceId: z.string().min(1).max(64),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().min(1).max(150).optional(),
  appVersion: z.string().min(1).max(30).optional(),
});
export type RegisterTokenBody = z.infer<typeof RegisterTokenBody>;

/* --------------------------------------------------------------------------
 * DELETE /notifications/tokens/:deviceId  — no body
 * -------------------------------------------------------------------------- */

export const UnregisterTokenParams = z.object({
  deviceId: z.string().min(1).max(64),
});
export type UnregisterTokenParams = z.infer<typeof UnregisterTokenParams>;

/* --------------------------------------------------------------------------
 * GET /notifications  — list inbox
 * -------------------------------------------------------------------------- */

export const ListNotificationsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
  category: z.enum(['quote', 'booking', 'payment', 'general']).optional(),
  /**
   * 'true' → unread only; 'false' (or absent) → all. Audit fix #14: this was
   * z.coerce.boolean(), which is JavaScript Boolean() — EVERY non-empty
   * string is true, so ?unread=false and ?unread=0 also returned unread-only.
   * Anything other than these values is now a 400 instead of a silent guess.
   */
  unread: z
    .enum(['true', 'false', '1', '0'])
    .transform(v => v === 'true' || v === '1')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

/* --------------------------------------------------------------------------
 * POST /notifications/:id/read  — mark one as read
 * -------------------------------------------------------------------------- */

export const NotificationUuidParams = z.object({
  id: z.string().uuid(),
});
export type NotificationUuidParams = z.infer<typeof NotificationUuidParams>;
