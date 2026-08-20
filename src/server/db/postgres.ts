/**
 * node-postgres adapter — production, and the CI job that runs the same suite
 * against a real PostgreSQL server so genuine concurrency is exercised.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
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
  /**
   * Confine every connection in this pool to one schema.
   *
   * Only the test harness passes it, and it exists because of a defect the
   * suite could not see. Under PGlite each test file gets its own in-process
   * database; against a real server they all share one, and every file's
   * `truncateAll()` takes an ACCESS EXCLUSIVE lock on every table. Twenty-seven
   * files doing that at once deadlock and wipe each other's fixtures mid-test —
   * which is exactly what happened the first time the suite was pointed at a
   * real PostgreSQL: 503 failures against 1034 passes on PGlite, none of them
   * a product defect.
   *
   * A schema per test file restores the isolation PGlite gave for free.
   * `public` stays on the search path because the extensions live there.
   */
  schema?: string;
}

/**
 * The connection and savepoint depth belonging to the transaction the current
 * async call-stack is inside, if any.
 *
 * This exists because `Db.transaction()` promises (sql.ts) that a nested call
 * joins the outer transaction via SAVEPOINT, and without it this driver could
 * not keep that promise. A service that calls another service's method — which
 * opens its own `this.db.transaction()` on the same root object — would take a
 * SECOND connection out of the pool. Its COMMIT would then survive the outer
 * ROLLBACK, so a failed operation could leave half its work behind, and the two
 * connections could block on each other's row locks with no third party to
 * break the deadlock.
 *
 * PGlite nests correctly (one connection, a depth counter), so the divergence
 * was invisible: the whole suite passed while production had the opposite
 * semantics. `AsyncLocalStorage` rather than a closure variable because a
 * server handles requests concurrently, and a shared variable would leak one
 * request's transaction into another's queries.
 */
interface TxContext {
  readonly client: pg.PoolClient;
  depth: number;
}

const currentTx = new AsyncLocalStorage<TxContext>();

/**
 * Quote an identifier for a place where a parameter cannot go.
 *
 * A schema name reaches this from the test harness only, and is generated
 * rather than user-supplied — but a connection-parameter string is one of the
 * few spots in this codebase where a value is not parameterised, so it is
 * validated rather than trusted.
 */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing an unsafe schema name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function createPostgresDb(opts: PostgresOptions): Db {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ...(opts.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: 'kvaterka',
    // Set as a connection parameter rather than by issuing `SET search_path`
    // after connecting: the pool hands out connections lazily and a per-query
    // SET would race with whatever the caller is already doing.
    ...(opts.schema ? { options: `-c search_path=${quoteIdent(opts.schema)},public` } : {}),
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

  /** A nested call: same connection, bracketed by a savepoint. */
  async function nested<T>(ctx: TxContext, fn: (tx: Sql) => Promise<T>): Promise<T> {
    const name = `sp_${ctx.depth}`;
    ctx.depth += 1;
    await ctx.client.query(`SAVEPOINT ${name}`);
    try {
      const out = await fn(wrap(ctx.client));
      await ctx.client.query(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await ctx.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    } finally {
      ctx.depth -= 1;
    }
  }

  return {
    // Outside a transaction these go straight to the pool. Inside one they must
    // go to the transaction's own connection, or a service that reads through
    // `db.query` mid-transaction would not see its own uncommitted writes.
    async query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const ctx = currentTx.getStore();
      return wrap(ctx ? ctx.client : pool).query<Row>(text, params);
    },
    async execScript(text: string) {
      const ctx = currentTx.getStore();
      return wrap(ctx ? ctx.client : pool).execScript(text);
    },

    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const existing = currentTx.getStore();
      if (existing) return nested(existing, fn);

      const client = await pool.connect();
      const ctx: TxContext = { client, depth: 1 };
      try {
        await client.query('BEGIN');
        const out = await currentTx.run(ctx, () => fn(wrap(client)));
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
