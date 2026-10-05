/**
 * ==============================================================================
 * auth.repository — push-token cleanup on sign-out
 * ==============================================================================
 * The `push_tokens` table is owned by the notifications module, which writes
 * it when the app registers for push. Auth only ever DELETES from it, at the
 * moments a device or an account stops being signed in (audit fix #7):
 *
 *   • logout (current device)        → that device's tokens
 *   • logout (all devices)           → every token for the account
 *   • forced revoke (blocked /
 *     suspended / deleted account)   → every token for the account
 *   • refresh-token reuse detected   → every token for the account
 *
 * Without this, a signed-out phone kept receiving the account's booking and
 * payment notifications until FCM itself expired the token.
 *
 * WHY NOT CALL THE NOTIFICATIONS MODULE?
 *   Cross-module imports must go through the target's index.ts
 *   (.depcruiserc.cjs), and notifications/index.ts initialises Firebase on
 *   import — that would make every auth unit test need Firebase credentials.
 *   A single scoped DELETE here keeps the modules decoupled.
 *
 * Matching uses device_id: the app must send the SAME device id to
 * /auth/otp/verify (device.id) and /notifications/tokens (deviceId). If it
 * doesn't, nothing is deleted on single-device logout — the token-claiming
 * upsert in notifications/repository.ts still stops the cross-account leak
 * at the next login on that phone.
 * ==============================================================================
 */
import { pool } from '../../../shared/db/pool.js';
import type { UserRole } from '../../../shared/rbac/roles.js';

/**
 * Delete push tokens for one account. `deviceId` null = every device.
 * Always scoped by (role, entity_id), so it can only touch the caller's own
 * rows.
 */
export async function deletePushTokens(
  role: UserRole,
  entityId: string,
  deviceId: string | null,
): Promise<void> {
  if (deviceId === null) {
    await pool.execute('DELETE FROM push_tokens WHERE role = ? AND entity_id = ?', [
      role,
      entityId,
    ]);
    return;
  }
  await pool.execute('DELETE FROM push_tokens WHERE role = ? AND entity_id = ? AND device_id = ?', [
    role,
    entityId,
    deviceId,
  ]);
}
