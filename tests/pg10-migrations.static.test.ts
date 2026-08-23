/**
 * PostgreSQL 10.23 compatibility — the half that needs no database.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * It used to live beside the runtime checks, and that made it useless at the
 * one moment it mattered. Adding `CREATE EXTENSION` to a migration breaks the
 * migration, so `beforeAll` threw, so every test in the file was reported as
 * skipped — including the assertion written to name exactly that mistake. The
 * build failed, but it failed saying nothing.
 *
 * Separated, this runs in milliseconds with no database of any kind, on every
 * machine and in every CI job, and when it fails it says which file used which
 * construct and what to use instead.
 *
 * Production is PostgreSQL 10.23 on shared hosting with no superuser: no
 * extension can be installed, and nothing from 11 or 12 exists. None of that is
 * visible from a passing suite, because the fast suite is PGlite (PostgreSQL 18)
 * and a developer's own server is newer still. Writing `EXECUTE FUNCTION` feels
 * fine right up to the moment it fails on the first migration, on the server, in
 * front of whoever is deploying.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

interface Migration {
  readonly file: string;
  /** Comments stripped, so prose about btree_gist does not read as a use of it. */
  readonly code: string;
}

/**
 * Remove `--` line comments and slash-star block comments.
 *
 * Done in one pass rather than two regexes because a `--` inside a block comment
 * and a `/*` inside a line comment both exist in these files, and running the
 * two patterns independently mangles them. Dollar-quoted function bodies are
 * left alone: they are code, and code is what we want to scan.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

const MIGRATIONS: readonly Migration[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({
    file,
    code: stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')),
  }));

/** Every banned construct, why it is banned, and what to use instead. */
const FORBIDDEN: readonly { pattern: RegExp; what: string; instead: string }[] = [
  {
    pattern: /\bCREATE\s+EXTENSION\b/i,
    what: 'CREATE EXTENSION',
    instead:
      'nothing — the production role is not a superuser and the statement fails, ' +
      'taking the whole migration with it',
  },
  {
    pattern: /\bEXECUTE\s+FUNCTION\b/i,
    what: 'EXECUTE FUNCTION (PostgreSQL 11+)',
    instead: 'EXECUTE PROCEDURE, which means the same thing and parses on 10',
  },
  {
    pattern: /\bGENERATED\s+ALWAYS\s+AS\s*\(/i,
    what: 'a generated column (PostgreSQL 12+)',
    instead: 'an ordinary column maintained by a BEFORE trigger, as booking.nights is',
  },
  {
    pattern: /\bCREATE\s+PROCEDURE\b/i,
    what: 'CREATE PROCEDURE (PostgreSQL 11+)',
    instead: 'CREATE FUNCTION',
  },
  {
    pattern: /\bEXCLUDE\s+USING\b/i,
    what: 'an EXCLUDE constraint',
    instead:
      'property_occupancy — one row per occupied night, with a primary key doing ' +
      'the same job without btree_gist',
  },
  {
    pattern: /\bgin_trgm_ops\b|\bgist_trgm_ops\b|\bsimilarity\s*\(|\bword_similarity\s*\(/i,
    what: 'pg_trgm',
    instead: "to_tsvector('russian', ...) with a core GIN index",
  },
  {
    pattern: /\bll_to_earth\s*\(|\bearth_box\s*\(|\bearth_distance\s*\(/i,
    what: 'earthdistance',
    instead: 'a latitude/longitude rectangle followed by haversine in plain SQL',
  },
  {
    pattern: /\bcitext\b/i,
    what: 'the citext type',
    instead: 'text with a unique index on lower(...)',
  },
  {
    pattern: /\bMERGE\s+INTO\b/i,
    what: 'MERGE (PostgreSQL 15+)',
    instead: 'INSERT ... ON CONFLICT',
  },
  {
    pattern: /\bALTER\s+SYSTEM\b|\bCOPY\s+.*\bFROM\s+PROGRAM\b|\bCREATE\s+TABLESPACE\b/i,
    what: 'a statement requiring superuser',
    instead: 'nothing the application can run on shared hosting',
  },
];

describe('PostgreSQL 10.23 compatibility — static scan of the migrations', () => {
  it('finds migration files to scan', () => {
    // A scan that silently found nothing would pass every assertion below.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(14);
  });

  for (const { pattern, what, instead } of FORBIDDEN) {
    it(`uses no ${what}`, () => {
      const offenders = MIGRATIONS.filter((m) => pattern.test(m.code)).map((m) => m.file);
      expect(
        offenders,
        offenders.length === 0
          ? ''
          : `${offenders.join(', ')} use ${what}, which PostgreSQL 10.23 on the production ` +
            `host cannot run. Use ${instead}.`,
      ).toEqual([]);
    });
  }

  /* The two triggers that keep property_occupancy correct are the double-booking
     guarantee. Deleting one would leave a schema that migrates cleanly, passes
     every type check, and silently allows two tenants into the same flat. */
  it('keeps both occupancy triggers attached', () => {
    const all = MIGRATIONS.map((m) => m.code).join('\n');
    expect(all).toMatch(/CREATE\s+TRIGGER\s+booking_occupancy\b/i);
    expect(all).toMatch(/CREATE\s+TRIGGER\s+calendar_block_occupancy\b/i);
    expect(all).toMatch(/CREATE\s+TABLE\s+property_occupancy\b/i);
  });

  /* The occupying status list is written once, in booking_status_occupies(), so
     that the two triggers cannot disagree about which statuses hold a night.
     REQUESTED must stay out of it: competing requests are the product (DEC-007). */
  it('defines the occupying status set exactly once, and REQUESTED is not in it', () => {
    const all = MIGRATIONS.map((m) => m.code).join('\n');
    const definitions = all.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+booking_status_occupies\b/gi);
    expect(definitions).toHaveLength(1);

    const body = all.slice(all.search(/FUNCTION\s+booking_status_occupies/i));
    const statuses = body.slice(0, body.indexOf('$$', body.indexOf('$$') + 2));
    expect(statuses).toContain('CONFIRMED');
    expect(statuses).toContain('COMPLETED');
    expect(statuses).not.toContain('REQUESTED');
  });
});

