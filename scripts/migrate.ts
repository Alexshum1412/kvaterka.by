/**
 * Apply migrations to a real PostgreSQL server.
 *
 * WHY THIS FILE HAD TO EXIST
 *
 * `package.json` has declared `db:migrate` since the first commit and pointed
 * at this path, which did not exist. `migrate()` was called from exactly two
 * places: the test harness, and the PGlite branch of `runtime.ts` that brings
 * up the in-process development database. Neither runs against production.
 *
 * So a real deployment had no way to build its schema at all. Every migration
 * was tested, checksummed and ordered — and unreachable. This is the command
 * that was missing, not a new mechanism: it calls the same `migrate()` the
 * tests call, against the connection string in the environment.
 *
 *   npm run db:migrate
 *
 * Exits non-zero on failure so a deploy pipeline stops rather than starting an
 * application against a schema that is not there.
 */

import { createPostgresDb } from '../src/server/db/postgres.ts';
import { migrate, MIGRATIONS_DIR } from '../src/server/db/migrator.ts';

const PGLITE = 'pglite';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];

  if (!url) {
    console.error('DATABASE_URL is not set. Nothing to migrate — refusing to guess.');
    process.exit(2);
  }

  if (url === PGLITE) {
    /* Not an error, and not a no-op worth hiding. The development database is
       created and migrated automatically when the app boots, so running this
       against it would either duplicate that work or, worse, migrate a
       throwaway instance and report success about a database nobody uses. */
    console.error(
      'DATABASE_URL=pglite is the in-process development database; it migrates itself on boot.\n' +
        'Set DATABASE_URL to a real PostgreSQL connection string to use this command.',
    );
    process.exit(2);
  }

  const db = createPostgresDb({
    connectionString: url,
    // One connection: migrations are strictly sequential and a pool would only
    // add ways for them to interleave.
    max: 1,
    ssl: process.env['DATABASE_SSL'] === 'true',
  });

  try {
    const result = await migrate(db, {
      ...(process.env['MIGRATIONS_DIR'] ? { dir: process.env['MIGRATIONS_DIR'] } : {}),
      onProgress: (filename) => console.log(`  applying ${filename}`),
    });

    if (result.applied.length === 0) {
      console.log(`Schema is current — ${result.alreadyApplied.length} migration(s) already applied.`);
    } else {
      console.log(
        `Applied ${result.applied.length} migration(s); ` +
          `${result.alreadyApplied.length} were already in place.`,
      );
    }
  } catch (error) {
    /* A checksum mismatch lands here, and its message is the important part:
       it means an already-applied file was edited, which is the one failure
       mode a migration runner must never paper over. */
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    await db.close();
  }
}

console.log(`Migrating ${describeTarget()} from ${MIGRATIONS_DIR}`);
await main();

/** The host and database, never the credentials. */
function describeTarget(): string {
  const url = process.env['DATABASE_URL'] ?? '';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'the configured database';
  }
}
