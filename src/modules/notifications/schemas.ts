/** notifications request schemas. */
import { z } from 'zod';

export const RegisterTokenBody = z.object({
  token: z.string().min(10).max(4096),
  deviceId: z.string().min(1).max(64),
  platform: z.enum(['ios', 'android']),
  deviceName: z.string().min(1).max(150).optional(),
  appVersion: z.string().min(1).max(30).optional(),
});
export type RegisterTokenBody = z.infer<typeof RegisterTokenBody>;

export const UnregisterTokenParams = z.object({
  deviceId: z.string().min(1).max(64),
});
export type UnregisterTokenParams = z.infer<typeof UnregisterTokenParams>;

export const ListNotificationsQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
  category: z.enum(['quote', 'booking', 'payment', 'general']).optional(),
  /**
   * true/1: unread only; false/0 or absent: all; anything else is a 400.
   * Not z.coerce.boolean(): that turns "false" into true.
   */
  unread: z
    .enum(['true', 'false', '1', '0'])
    .transform(v => v === 'true' || v === '1')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;

export const NotificationUuidParams = z.object({
  id: z.string().uuid(),
});
export type NotificationUuidParams = z.infer<typeof NotificationUuidParams>;
