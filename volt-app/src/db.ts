import { Pool, PoolClient } from 'pg';
import { config } from './config';
import { scaleConfig } from './scale/config';

// DB_POOL_MAX (default 10, as before). Behind RDS Proxy many tasks share a
// smaller set of real connections, so this can stay modest per task.
export const pool = new Pool({ connectionString: config.databaseUrl, max: scaleConfig.dbPoolMax });

/** Simple query helper. */
export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run a function inside a transaction. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
