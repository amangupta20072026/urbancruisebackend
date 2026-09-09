/**
 * ==============================================================================
 * MySQL connection pool — singleton
 * ==============================================================================
 * mysql2/promise pool created ONCE at module load. Import `pool` anywhere;
 * never call `mysql.createPool` again. Multiple pools per process silently
 * blow past MySQL's `max_connections`.
 *
 * Prepared statements (`pool.execute`) are the default — never build SQL with
 * string concatenation. `?` placeholders bind values through mysql2's escape
 * layer, which is the ONLY correct SQL-injection defense.
 *
 * `enableKeepAlive` prevents intermediate stateful firewalls / load balancers
 * from silently killing idle connections after ~1 minute, which used to cause
 * `ECONNRESET` on the first query after a lull.
 * ==============================================================================
 */
import mysql, { type Pool } from 'mysql2/promise';
import { ENV } from '../../config/env.js';
import { logger } from '../logger/index.js';

export const pool: Pool = mysql.createPool({
  host: ENV.DB_HOST,
  port: ENV.DB_PORT,
  user: ENV.DB_USER,
  password: ENV.DB_PASSWORD,
  database: ENV.DB_NAME,

  // Pool sizing
  connectionLimit: ENV.DB_POOL_LIMIT,
  queueLimit: 0,
  waitForConnections: true,

  // Connection health
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  connectTimeout: ENV.DB_CONNECT_TIMEOUT_MS,

  // Correctness
  timezone: 'Z', // datetime columns treated as UTC on the wire
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: true, // avoid silent precision loss on BIGINT
  decimalNumbers: false, // keep DECIMAL as string for financial accuracy
  namedPlaceholders: false,
});

/**
 * Runs `SELECT 1` — used by /ready to prove the DB is reachable. Never call
 * this from hot paths; it's a checkup, not a query.
 */
export async function ping(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}

/** Drain and close the pool. Called during graceful shutdown. */
export async function closePool(): Promise<void> {
  try {
    await pool.end();
    logger.info('mysql pool closed');
  } catch (err) {
    logger.error({ err }, 'error while closing mysql pool');
  }
}

export async function verifyConnection(): Promise<void> {
  try {
    await ping();
    logger.info('database connection established');
  } catch (err) {
    logger.fatal({ err }, 'database connection failed at startup');
    throw err;
  }
}
