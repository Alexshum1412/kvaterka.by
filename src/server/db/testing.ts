/**
 * Test database factory.
 *
 * Default: PGlite (real PostgreSQL 18, in-process, no Docker required).
 * Set TEST_DATABASE_URL to run the identical suite against a real server — that
 * is the mode that exercises genuine simultaneous transactions, and it is what
 * CI runs before a release.
 *
 * ONE SCHEMA PER TEST FILE, and it took the first real run to learn why.
 *
 * Under PGlite each call to `createTestDb()` builds a private in-process
 * database, so test files are isolated for free and nobody had to think about
 * it. Against a real server they all connect to the SAME database, and every
 * file's `truncateAll()` takes an ACCESS EXCLUSIVE lock on every table. Run
 * twenty-seven files in parallel and they deadlock, and delete each other's
 * fixtures halfway through an assertion. The first time this suite was pointed
 * at a real PostgreSQL it produced 503 failures against 1034 passes on PGlite —
 * and not one of them was a product defect.
 *
 * So each file gets its own schema, created here and dropped on close. That
 * restores the isolation PGlite gave implicitly, keeps the parallelism, and
 * makes the two modes mean the same thing — which is the entire point of
 * running the suite twice.
 */

import { randomUUID } from 'node:crypto';
import type { Db } from './sql.ts';
import { migrate } from './migrator.ts';

export interface TestDb extends Db {
  /** Wipe all data but keep the schema. Much faster than re-migrating. */
  truncateAll(): Promise<void>;
  readonly driver: 'pglite' | 'postgres';
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;

  if (url) {
    const { createPostgresDb } = await import('./postgres.ts');

    // Random rather than derived from the file name: vitest gives no reliable
    // per-file identifier here, and a leftover schema from a killed run must
    // never be adopted by a later one and silently reused with stale rows.
    const schema = `t_${randomUUID().replace(/-/g, '')}`;

    const admin = createPostgresDb({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.close();

    const db = createPostgresDb({ connectionString: url, max: 8, schema });
    await migrate(db);
    return withHelpers(db, 'postgres', schema, url);
  }

  const { createPgliteDb } = await import('./pglite.ts');
  const db = await createPgliteDb();
  await migrate(db);
  return withHelpers(db, 'pglite', 'public');
}

function withHelpers(db: Db, driver: 'pglite' | 'postgres', schema: string, url?: string): TestDb {
  return {
    ...db,
    driver,
    async truncateAll() {
      const { rows } = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = $1 AND tablename <> 'schema_migration'`,
        [schema],
      );
      if (rows.length === 0) return;
      const list = rows.map((r) => `"${r.tablename}"`).join(', ');
      // Append-only triggers fire on DELETE but not on TRUNCATE, which is
      // exactly what a test reset needs.
      await db.execScript(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
    },
    async close() {
      await db.close();
      if (driver === 'postgres' && url) {
        /* Dropped from a fresh connection because the pool that owned this
           schema is now closed. Failure here must not fail the suite: a
           leftover schema is untidy, a test run that reports red because of
           cleanup is misleading. */
        try {
          const { createPostgresDb } = await import('./postgres.ts');
          const admin = createPostgresDb({ connectionString: url, max: 1 });
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          await admin.close();
        } catch {
          /* untidy, not wrong */
        }
      }
    },
  };
}
