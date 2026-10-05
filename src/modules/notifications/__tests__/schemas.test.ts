/**
 * Notification list query parsing — audit item #14.
 */
import { describe, it, expect } from 'vitest';
import { ListNotificationsQuery } from '../schemas.js';

describe('ListNotificationsQuery.unread (audit #14 regression)', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false], // was: true (z.coerce.boolean bug)
    ['0', false], // was: true
  ])('?unread=%s → %s', (raw, expected) => {
    expect(ListNotificationsQuery.parse({ unread: raw }).unread).toBe(expected);
  });

  it('absent → undefined (no filter)', () => {
    expect(ListNotificationsQuery.parse({}).unread).toBeUndefined();
  });

  it.each(['yes', 'TRUE ', '2', ''])('rejects ambiguous value %j instead of guessing', raw => {
    expect(ListNotificationsQuery.safeParse({ unread: raw }).success).toBe(false);
  });

  it('page/pageSize behaviour unchanged', () => {
    expect(ListNotificationsQuery.parse({ page: '2', pageSize: '10' })).toMatchObject({
      page: 2,
      pageSize: 10,
    });
  });
});
