/**
 * node-postgres adapter — production, and the CI job that runs the same suite
 * against a real PostgreSQL server so genuine concurrency is exercised.
 */

import pg from 'pg';
import type { Db, QueryResult, Sql } from './sql.ts';

const { Pool } = pg;

// bigint (int8) arrives as a string by default so precision is not lost. Money
// columns are int8 and are converted to bigint by the repositories; leaving the
// default alone is deliberate — never let pg hand back a lossy JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => v);

export interface PostgresOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  ssl?: boolean;
}

export function createPostgresDb(opts: PostgresOptions): Db {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ...(opts.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: 'kvaterka',
  });

  const wrap = (client: pg.PoolClient | pg.Pool): Sql => ({
    async query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const res = await client.query(text, params ? [...params] : undefined);
      return { rows: res.rows as Row[], rowCount: res.rowCount ?? res.rows.length } satisfies QueryResult<Row>;
    },
    async execScript(text: string) {
      await client.query(text);
    },
  });

  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The connection is already broken; the pool will discard it.
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
