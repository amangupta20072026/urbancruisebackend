/**
 * ==============================================================================
 * RBAC actions — the verbs the authorize() middleware understands
 * ==============================================================================
 * Kept small on purpose. Fine-grained authorization lives in a module's
 * policy.ts (canOperate). The middleware here is the coarse guard rail.
 * ==============================================================================
 */

export type Action =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'confirm'
  | 'assign'
  | 'approve'
  | 'reject'
  | 'acknowledge';
