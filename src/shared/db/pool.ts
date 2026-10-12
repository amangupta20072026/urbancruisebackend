/**
 * The single MySQL pool for the process. Always import this one; extra pools
 * multiply connections toward MySQL's max_connections.
 * Always use ? placeholders — never build SQL by string concatenation.
 */
import mysql, { type Pool } from 'mysql2/promise';
import { ENV } from '../../config/env.js';
import { logger } from '../logger/index.js';

/** The single MySQL pool for the process. Always import this one; extra pools
 * multiply connections toward MySQL's max_connections. */
export const pool: Pool = mysql.createPool({
  host: ENV.DB_HOST,
  port: ENV.DB_PORT,
  user: ENV.DB_USER,
  password: ENV.DB_PASSWORD,
  database: ENV.DB_NAME,

  connectionLimit: ENV.DB_POOL_LIMIT,
  queueLimit: 0,
  waitForConnections: true,

  // Keep-alive stops firewalls from silently dropping idle connections.
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
  connectTimeout: ENV.DB_CONNECT_TIMEOUT_MS,

  timezone: 'Z', // read and write DATETIME values as UTC
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: true, // BIGINT as string to avoid precision loss
  decimalNumbers: false, // DECIMAL as string to keep money exact
  namedPlaceholders: false,
});

/** Health check (SELECT 1) used by /ready and at startup. */
export async function ping(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
  } finally {
    conn.release();
  }
}

/** Closes the pool on shutdown. Logs instead of throwing. */
export async function closePool(): Promise<void> {
  try {
    await pool.end();
    logger.info('mysql pool closed');
  } catch (err) {
    logger.error({ err }, 'error while closing mysql pool');
  }
}

/** Startup check: logs and rethrows if the database is unreachable. */
export async function verifyConnection(): Promise<void> {
  try {
    await ping();
    logger.info('database connection established');
  } catch (err) {
    logger.fatal({ err }, 'database connection failed at startup');
    throw err;
  }
}
