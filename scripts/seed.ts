/**
 * Seed demonstration data into a real PostgreSQL server.
 *
 * The companion to `scripts/migrate.ts`, and missing for the same reason:
 * `package.json` declared `db:seed` and pointed at a file that did not exist.
 * `seedDemoData()` ran only inside the PGlite development boot path.
 *
 *   npm run db:seed
 *
 * REFUSES TO RUN IN PRODUCTION. The seed writes invented people with known
 * passwords — a demonstration fixture, not a fixture anybody should be able to
 * sign in as on a live deployment. `NODE_ENV=production` stops it here rather
 * than relying on nobody typing the command.
 */

import { createPostgresDb } from '../src/server/db/postgres.ts';
import { seedDemoData } from '../src/server/db/seed.ts';

const PGLITE = 'pglite';

const url = process.env['DATABASE_URL'];

if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess where to write demo data.');
  process.exit(2);
}

if (url === PGLITE) {
  console.error(
    'DATABASE_URL=pglite seeds itself on boot; run `npm run dev` instead.\n' +
      'Set DATABASE_URL to a real PostgreSQL connection string to use this command.',
  );
  process.exit(2);
}

if (process.env['NODE_ENV'] === 'production') {
  console.error(
    'Refusing to seed demonstration accounts into a production database.\n' +
      'These fixtures have known passwords and are not safe on a live deployment.',
  );
  process.exit(2);
}

const db = createPostgresDb({
  connectionString: url,
  max: 1,
  ssl: process.env['DATABASE_SSL'] === 'true',
});

try {
  // seedDemoData is idempotent: it returns early if the data is already there,
  // so running this twice is safe and says so rather than duplicating anything.
  const { listings } = await seedDemoData(db);
  console.log(listings === 0 ? 'Demo data already present — nothing written.' : `Seeded ${listings} listing(s).`);
} catch (error) {
  console.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
} finally {
  await db.close();
}
