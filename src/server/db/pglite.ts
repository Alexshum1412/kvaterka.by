/**
 * PGlite adapter — a real PostgreSQL 18 engine compiled to WebAssembly, running
 * in-process.
 *
 * Used for tests. This is not a stub: triggers, primary keys, daterange
 * operators and the Russian text-search configuration all behave exactly as
 * they do on a server, so a test that proves double booking is impossible is
 * proving it about the real mechanism.
 *
 * NOTE: this engine is PostgreSQL 18 while production is PostgreSQL 10.23, so it
 * cannot prove version compatibility either — that is what the real-PG10 suite
 * is for (tests/pg10-compatibility.test.ts and the postgres:10.23 CI job).
 *
 * LIMITATION (recorded honestly, see REPO_AUDIT.md): PGlite serialises all work
 * onto a single connection, so it cannot exercise *simultaneous* transactions.
 * Constraint enforcement is fully testable here; true concurrency races are
 * covered by the same suite run against a real server via TEST_DATABASE_URL.
 */

import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult, Sql } from './sql.ts';

/**
 * @param dataDir Persist to disk instead of memory. Tests want a fresh
 * in-memory database every time; the zero-setup development mode wants data to
 * survive a hot reload, otherwise every code change silently invalidates every
 * id on screen.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  /* NO EXTENSIONS LOADED, ON PURPOSE.
     Five used to be: btree_gist, pg_trgm, citext, cube, earthdistance. PGlite
     offers them and loading them costs nothing, which is precisely the problem —
     production runs on shared hosting where CREATE EXTENSION is refused, so a
     test database that has them can prove a query works when the real one
     cannot run it at all. Withholding them here is what makes the fast test
     mode honest about the target. */
  const pg = new PGlite({
    ...(dataDir ? { dataDir } : {}),
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
