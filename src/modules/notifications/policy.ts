/**
 * notifications — policy
 * Instance-level authorization. The coarse RBAC gate (authorize middleware)
 * already checked the role. This layer checks the specific instance.
 *
 * Notifications are tenant-scoped by entity_id in every SQL query (see
 * repository.ts). There is no additional instance-level policy needed today —
 * a user cannot accidentally read another user's notification because the SQL
 * WHERE clause already enforces it.
 *
 * Kept here as a named export so the pattern is consistent with other modules
 * and a future "share a notification" or "admin can view" rule has a clear home.
 */
export {};
