/**
 * Test database factory.
 *
 * Default: PGlite (real PostgreSQL 18, in-process, no Docker required).
 * Set TEST_DATABASE_URL to run the identical suite against a real server — that
 * is the mode that exercises genuine simultaneous transactions, and it is what
 * CI runs before a release.
 */

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
    const db = createPostgresDb({ connectionString: url, max: 8 });
    await migrate(db);
    return withHelpers(db, 'postgres');
  }

  const { createPgliteDb } = await import('./pglite.ts');
  const db = await createPgliteDb();
  await migrate(db);
  return withHelpers(db, 'pglite');
}

function withHelpers(db: Db, driver: 'pglite' | 'postgres'): TestDb {
  return {
    ...db,
    driver,
    async truncateAll() {
      const { rows } = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
         WHERE schemaname = 'public' AND tablename <> 'schema_migration'`,
      );
      if (rows.length === 0) return;
      const list = rows.map((r) => `"${r.tablename}"`).join(', ');
      // Append-only triggers fire on DELETE but not on TRUNCATE, which is
      // exactly what a test reset needs.
      await db.execScript(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
    },
  };
}
