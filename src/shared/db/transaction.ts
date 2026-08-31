/**
 * ==============================================================================
 * withTransaction — the ONLY way to run a multi-statement transaction
 * ==============================================================================
 * Guarantees:
 *   - one connection per transaction (never shared across concurrent work)
 *   - commit on success, rollback on any thrown error
 *   - release the connection back to the pool in all cases
 *
 * Usage:
 *     await withTransaction(async (conn) => {
 *       await conn.execute('UPDATE ...', [args]);
 *       await conn.execute('INSERT ...', [args]);
 *       return { ok: true };
 *     });
 * ==============================================================================
 */
import type { PoolConnection } from 'mysql2/promise';
import { pool } from './pool.js';

export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
}
