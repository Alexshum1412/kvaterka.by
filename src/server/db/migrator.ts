/**
 * Migration runner.
 *
 * Deliberately hand-written rather than delegated to an ORM's migrate command:
 * the schema leans on EXCLUDE constraints, partial indexes, constraint triggers
 * and generated columns, none of which survive a round-trip through a
 * schema-diffing tool. The SQL files ARE the schema, and they are applied
 * verbatim, in order, exactly once.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from './sql.ts';

export interface Migration {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * Resolved from the working directory rather than from `import.meta.url`.
 *
 * A relative `new URL(..., import.meta.url)` looks like a module specifier to a
 * bundler, and webpack fails the build trying to resolve `db/migrations` as a
 * package — a failure that appears only at runtime, never in typecheck.
 * `MIGRATIONS_DIR` overrides it for deployments that relocate the folder.
 */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'db', 'migrations');

const FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  const bad = entries.filter((f) => !FILENAME_PATTERN.test(f));
  if (bad.length > 0) {
    throw new Error(`Migration filenames must look like 0001_name.sql — offending: ${bad.join(', ')}`);
  }

  const seenPrefixes = new Set<string>();
  const migrations: Migration[] = [];
  for (const filename of entries) {
    const prefix = filename.slice(0, 4);
    if (seenPrefixes.has(prefix)) throw new Error(`Duplicate migration number ${prefix}`);
    seenPrefixes.add(prefix);

    const sql = await readFile(path.join(dir, filename), 'utf8');
    migrations.push({ filename, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return migrations;
}

async function ensureMigrationTable(sql: Sql): Promise<void> {
  await sql.execScript(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export interface MigrateResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

/**
 * Apply every pending migration.
 *
 * Each file runs inside its own transaction, so a failure leaves the database
 * on the last complete migration rather than half-way through one.
 */
export async function migrate(
  db: Sql & { transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> },
  opts: { dir?: string; onProgress?: (filename: string) => void } = {},
): Promise<MigrateResult> {
  const migrations = await loadMigrations(opts.dir);
  await ensureMigrationTable(db);

  const { rows } = await db.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  // An already-applied migration whose file changed means someone edited
  // history. Refuse rather than silently diverge from production.
  for (const m of migrations) {
    const previous = applied.get(m.filename);
    if (previous !== undefined && previous !== m.checksum) {
      throw new Error(
        `Migration ${m.filename} was modified after being applied ` +
          `(recorded ${previous.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
          `Add a new migration instead of editing an applied one.`,
      );
    }
  }

  const pending = migrations.filter((m) => !applied.has(m.filename));
  for (const m of pending) {
    await db.transaction(async (tx) => {
      await tx.execScript(m.sql);
      await tx.query('INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)', [
        m.filename,
        m.checksum,
      ]);
    });
    opts.onProgress?.(m.filename);
  }

  return {
    applied: pending.map((m) => m.filename),
    alreadyApplied: migrations.filter((m) => applied.has(m.filename)).map((m) => m.filename),
  };
}
