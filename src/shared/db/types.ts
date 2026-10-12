/** Short aliases for mysql2 result types used by repositories. */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

/** SELECT row. Extend it with the table's columns. */
export type Row = RowDataPacket;

/** INSERT/UPDATE/DELETE result (affectedRows, insertId, ...). */
export type Mutation = ResultSetHeader;
