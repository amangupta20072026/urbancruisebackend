/** Actions used by authorize(). Keep this list small. */

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
