/**
 * ==============================================================================
 * DB row-shape helpers
 * ==============================================================================
 * mysql2 returns `[rows, fields]` from execute() where `rows` is typed as
 * `QueryResult` — too loose. These helpers give repositories precise typing
 * with minimal casts.
 * ==============================================================================
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

/** A row from a SELECT — extend with your columns:  `interface BookingRow extends Row { id: string; ... }` */
export type Row = RowDataPacket;

/** Returned by INSERT/UPDATE/DELETE — has `affectedRows`, `insertId`, etc. */
export type Mutation = ResultSetHeader;
