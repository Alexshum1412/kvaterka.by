/**
 * PGlite adapter — a real PostgreSQL 18 engine compiled to WebAssembly, running
 * in-process.
 *
 * Used for tests. This is not a stub: EXCLUDE constraints, constraint triggers,
 * generated columns, daterange operators and the Russian text-search
 * configuration all behave exactly as they do on a server, so a test that
 * proves double booking is impossible is proving it about the real mechanism.
 *
 * LIMITATION (recorded honestly, see REPO_AUDIT.md): PGlite serialises all work
 * onto a single connection, so it cannot exercise *simultaneous* transactions.
 * Constraint enforcement is fully testable here; true concurrency races are
 * covered by the same suite run against a real server via TEST_DATABASE_URL.
 */

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { cube } from '@electric-sql/pglite/contrib/cube';
import { earthdistance } from '@electric-sql/pglite/contrib/earthdistance';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Db, QueryResult, Sql } from './sql.ts';

export async function createPgliteDb(): Promise<Db> {
  const pg = new PGlite({
    extensions: { btree_gist, pg_trgm, citext, cube, earthdistance },
  });
  await pg.waitReady;

  let depth = 0;

  const exec = async (text: string, params?: readonly unknown[]): Promise<QueryResult> => {
    const res = await pg.query(text, params ? [...params] : undefined);
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.affectedRows ?? res.rows.length };
  };

  const sql: Sql = {
    query: exec as Sql['query'],
    execScript: async (text) => {
      await pg.exec(text);
    },
  };

  return {
    ...sql,
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      // Savepoints for nesting: an inner failure must not commit the outer work.
      if (depth > 0) {
        const name = `sp_${depth}`;
        depth += 1;
        await pg.exec(`SAVEPOINT ${name}`);
        try {
          const out = await fn(sql);
          await pg.exec(`RELEASE SAVEPOINT ${name}`);
          return out;
        } catch (e) {
          await pg.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          throw e;
        } finally {
          depth -= 1;
        }
      }

      depth = 1;
      await pg.exec('BEGIN');
      try {
        const out = await fn(sql);
        await pg.exec('COMMIT');
        return out;
      } catch (e) {
        await pg.exec('ROLLBACK');
        throw e;
      } finally {
        depth = 0;
      }
    },
    async close() {
      await pg.close();
    },
  };
}
