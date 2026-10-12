/**
 * Runs fn inside a transaction on its own connection: commits on success,
 * rolls back if fn throws, and always releases the connection.
 * Use the given conn for every query that must be part of the transaction.
 */
import type { PoolConnection } from 'mysql2/promise';
import { pool } from './pool.js';

/** Runs fn inside a transaction on its own connection: commits on success,
 * rolls back if fn throws, and always releases the connection. Use the given
 * conn for every query that must be part of the transaction.
 */
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
