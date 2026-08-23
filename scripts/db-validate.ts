/**
 * Read-only structural validation of a Kvaterka database.
 *
 * WHAT THIS IS FOR
 *
 * A restore that finishes without an error is not a restore that worked. The
 * only way to know a copy is faithful is to ask both databases the same
 * questions and compare the answers, and the only way to know a database is
 * internally coherent is to ask it for the states that should be impossible.
 * This does both.
 *
 *   node --experimental-transform-types scripts/db-validate.ts
 *   node --experimental-transform-types scripts/db-validate.ts --compare "postgres://..."
 *   node --experimental-transform-types scripts/db-validate.ts --fingerprint --json
 *
 * IT NEVER PRINTS PERSONAL DATA. Not an email, not a phone number, not a name,
 * not a message, not an address, not a document key. Counts, timestamps of the
 * oldest and newest row, and hashes — nothing else leaves this process. That is
 * a deliberate constraint, because the natural place to run it is a terminal
 * whose scrollback ends up in a chat window or a ticket.
 *
 * IT NEVER WRITES. The session is opened read-only at the server, so a mistake
 * in this file is refused by PostgreSQL rather than caught by review.
 *
 * The checks derive themselves from the live catalogue — the table list from
 * pg_tables, the referential checks from pg_constraint — so a migration that
 * adds a table or a foreign key is covered the next time this runs, without
 * anybody remembering to add it here. Only the domain invariants at the bottom
 * are written out by hand, because only a person knows what they mean.
 */

import { createPostgresDb } from '../src/server/db/postgres.ts';
import type { Db } from '../src/server/db/sql.ts';

/* ------------------------------------------------------------------ */
/* shape                                                               */
/* ------------------------------------------------------------------ */

interface TableStat {
  readonly table: string;
  readonly rows: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly fingerprint: string | null;
}

interface Problem {
  readonly check: string;
  readonly count: number;
  readonly detail: string;
  readonly severity: 'FATAL' | 'WARN';
}

interface Report {
  readonly target: string;
  readonly serverVersion: string;
  readonly encoding: string;
  readonly ctype: string;
  readonly extensions: string[];
  readonly migrationsApplied: number;
  readonly tables: TableStat[];
  readonly totalRows: number;
  readonly problems: Problem[];
}

/* ------------------------------------------------------------------ */
/* argument handling                                                   */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const wantFingerprint = argv.includes('--fingerprint');
const compareIndex = argv.indexOf('--compare');
const compareUrl = compareIndex >= 0 ? argv[compareIndex + 1] : undefined;

function describe(url: string): string {
  // Never print the password, even into a local terminal.
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/* ------------------------------------------------------------------ */
/* collection                                                          */
/* ------------------------------------------------------------------ */

async function connect(url: string): Promise<Db> {
  const db = createPostgresDb({
    connectionString: url,
    max: 1,
    ssl: process.env['DATABASE_SSL'] === 'true',
  });
  /* Enforced by the server, not by discipline. Every statement this process
     sends after this point is refused if it would write. */
  await db.query('SET default_transaction_read_only = on');
  return db;
}

async function collect(url: string): Promise<Report> {
  const db = await connect(url);
  try {
    const { rows: env } = await db.query<{
      version: string;
      encoding: string;
      ctype: string;
    }>(
      `SELECT current_setting('server_version') AS version,
              current_setting('server_encoding') AS encoding,
              current_setting('lc_ctype')        AS ctype`,
    );

    const { rows: exts } = await db.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`,
    );

    const { rows: migrations } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM schema_migration`,
    );

    const { rows: tableRows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`,
    );

    /* Which tables carry a created_at, asked once rather than guessed. */
    const { rows: withCreatedAt } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'created_at'`,
    );
    const hasCreatedAt = new Set(withCreatedAt.map((r) => r.table_name));

    const { rows: withId } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'id'`,
    );
    const hasId = new Set(withId.map((r) => r.table_name));

    const tables: TableStat[] = [];
    for (const { tablename } of tableRows) {
      const q = quoteIdent(tablename);
      const time = hasCreatedAt.has(tablename)
        ? `min(created_at)::text AS oldest, max(created_at)::text AS newest`
        : `NULL::text AS oldest, NULL::text AS newest`;

      /* A hash over the primary keys in order. Two databases holding the same
         rows produce the same string; one missing a row or holding an extra one
         does not. It is off by default because it reads every id in the table,
         which is the one expensive thing this script can do. */
      const fingerprint =
        wantFingerprint && hasId.has(tablename)
          ? `md5(coalesce(string_agg(id::text, ',' ORDER BY id::text), '')) AS fingerprint`
          : `NULL::text AS fingerprint`;

      const { rows } = await db.query<{
        rows: string;
        oldest: string | null;
        newest: string | null;
        fingerprint: string | null;
      }>(`SELECT count(*)::text AS rows, ${time}, ${fingerprint} FROM ${q}`);

      const r = rows[0]!;
      tables.push({
        table: tablename,
        rows: Number(r.rows),
        oldest: r.oldest,
        newest: r.newest,
        fingerprint: r.fingerprint,
      });
    }

    const problems = [
      ...(await referentialProblems(db)),
      ...(await domainProblems(db, new Set(tableRows.map((t) => t.tablename)))),
    ];

    return {
      target: describe(url),
      serverVersion: env[0]!.version,
      encoding: env[0]!.encoding,
      ctype: env[0]!.ctype,
      extensions: exts.map((e) => e.extname),
      migrationsApplied: Number(migrations[0]!.c),
      tables,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
      problems,
    };
  } finally {
    await db.close();
  }
}

/** Identifiers come from the catalogue, but they are still quoted. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to interpolate an unexpected table name: ${name}`);
  }
  return `"${name}"`;
}

/* ------------------------------------------------------------------ */
/* referential integrity, derived from the catalogue                   */
/* ------------------------------------------------------------------ */

/**
 * Every foreign key, checked for children whose parent is gone.
 *
 * With the constraints enabled this can only ever return zero — which is
 * exactly why it is worth running after a restore. `pg_restore --disable-
 * triggers`, a data-only load in the wrong order, or a hand-repaired dump can
 * all leave a database whose constraints are declared but whose rows do not
 * satisfy them, and nothing will tell you until a JOIN quietly drops a row.
 */
async function referentialProblems(db: Db): Promise<Problem[]> {
  const { rows: fks } = await db.query<{
    conname: string;
    child: string;
    child_cols: string[];
    parent: string;
    parent_cols: string[];
  }>(
    `SELECT c.conname,
            child.relname  AS child,
            array_agg(child_att.attname::text  ORDER BY k.ord)  AS child_cols,
            parent.relname AS parent,
            array_agg(parent_att.attname::text ORDER BY k.ord)  AS parent_cols
       FROM pg_constraint c
       JOIN pg_class child  ON child.oid  = c.conrelid
       JOIN pg_class parent ON parent.oid = c.confrelid
       JOIN pg_namespace n  ON n.oid = child.relnamespace
       JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child_attnum, parent_attnum, ord)
            ON true
       JOIN pg_attribute child_att
            ON child_att.attrelid = c.conrelid  AND child_att.attnum = k.child_attnum
       JOIN pg_attribute parent_att
            ON parent_att.attrelid = c.confrelid AND parent_att.attnum = k.parent_attnum
      WHERE c.contype = 'f' AND n.nspname = 'public'
      GROUP BY c.conname, child.relname, parent.relname
      ORDER BY child.relname, c.conname`,
  );

  const problems: Problem[] = [];
  for (const fk of fks) {
    const childCols = fk.child_cols.map(quoteIdent);
    const parentCols = fk.parent_cols.map(quoteIdent);
    const join = childCols.map((c, i) => `p.${parentCols[i]} = ch.${c}`).join(' AND ');
    const notNull = childCols.map((c) => `ch.${c} IS NOT NULL`).join(' AND ');

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c
         FROM ${quoteIdent(fk.child)} ch
        WHERE ${notNull}
          AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(fk.parent)} p WHERE ${join})`,
    );
    const count = Number(rows[0]!.c);
    if (count > 0) {
      problems.push({
        check: `orphans: ${fk.conname}`,
        count,
        detail: `${fk.child}.${fk.child_cols.join(',')} points at ${fk.parent} rows that are not there`,
        severity: 'FATAL',
      });
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* domain invariants, written by hand because they mean something      */
/* ------------------------------------------------------------------ */

const OCCUPYING = `('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','DISPUTED','COMPLETED')`;

interface Check {
  readonly name: string;
  readonly sql: string;
  readonly detail: string;
  readonly severity?: 'FATAL' | 'WARN';
  /** Skipped when the table is absent, so an older database still validates. */
  readonly needs?: string[];
}

const CHECKS: readonly Check[] = [
  {
    name: 'duplicate emails ignoring case',
    needs: ['app_user'],
    sql: `SELECT count(*)::text AS c FROM (
            SELECT lower(email) FROM app_user WHERE email IS NOT NULL
             GROUP BY lower(email) HAVING count(*) > 1) d`,
    detail:
      'two accounts differing only in capitalisation — the unique index on lower(email) ' +
      'should make this impossible, so a hit means the index is missing or was created invalid',
  },
  {
    name: 'bookings whose nights disagree with their dates',
    needs: ['booking'],
    sql: `SELECT count(*)::text AS c FROM booking
           WHERE nights <> upper(stay_period) - lower(stay_period)`,
    detail:
      'the booking_nights trigger did not run — likely a data-only restore loaded with ' +
      'triggers disabled and never recomputed',
  },
  {
    name: 'occupying bookings missing occupancy rows',
    needs: ['booking', 'property_occupancy'],
    sql: `SELECT count(*)::text AS c FROM booking b
           WHERE b.status IN ${OCCUPYING}
             AND (SELECT count(*) FROM property_occupancy po WHERE po.booking_id = b.id)
                 <> (upper(b.stay_period) - lower(b.stay_period))`,
    detail:
      'a confirmed booking does not hold all of its nights. The calendar would show those ' +
      'nights as free and a second tenant could book them',
  },
  {
    name: 'occupancy rows held by a booking that no longer occupies',
    needs: ['booking', 'property_occupancy'],
    sql: `SELECT count(*)::text AS c FROM property_occupancy po
           JOIN booking b ON b.id = po.booking_id
          WHERE b.status NOT IN ${OCCUPYING}`,
    detail:
      'a cancelled or expired booking is still holding nights. Those nights are unsellable ' +
      'and nothing will ever release them',
  },
  {
    name: 'occupancy rows on the wrong property',
    needs: ['booking', 'property_occupancy'],
    sql: `SELECT count(*)::text AS c FROM property_occupancy po
           JOIN booking b ON b.id = po.booking_id
          WHERE b.property_id <> po.property_id`,
    detail: 'an occupancy row is blocking a night on a property its booking does not belong to',
  },
  {
    name: 'occupancy rows outside their booking’s dates',
    needs: ['booking', 'property_occupancy'],
    sql: `SELECT count(*)::text AS c FROM property_occupancy po
           JOIN booking b ON b.id = po.booking_id
          WHERE po.night < lower(b.stay_period) OR po.night >= upper(b.stay_period)`,
    detail: 'an occupancy row falls outside the stay it claims to belong to',
  },
  {
    name: 'occupancy rows with no claimant or two',
    needs: ['property_occupancy'],
    sql: `SELECT count(*)::text AS c FROM property_occupancy
           WHERE (booking_id IS NULL) = (block_id IS NULL)`,
    detail: 'the property_occupancy_one_claimant check is not being enforced',
  },
  {
    name: 'confirmed bookings with unfrozen terms',
    needs: ['booking'],
    sql: `SELECT count(*)::text AS c FROM booking
           WHERE confirmed_at IS NOT NULL AND terms_frozen_at IS NULL`,
    detail: 'money that was agreed but never frozen — the dispute record would be incomplete',
  },
  {
    name: 'completed bookings with no completion timestamp',
    needs: ['booking'],
    sql: `SELECT count(*)::text AS c FROM booking
           WHERE status = 'COMPLETED' AND completed_at IS NULL`,
    detail: 'an impossible FSM state',
  },
  {
    name: 'published properties with no publication timestamp',
    needs: ['property'],
    sql: `SELECT count(*)::text AS c FROM property
           WHERE status = 'PUBLISHED' AND published_at IS NULL`,
    detail: 'an impossible listing state',
  },
  {
    name: 'ledger entries that do not balance to a booking',
    needs: ['ledger_entry'],
    sql: `SELECT count(*)::text AS c FROM ledger_entry WHERE amount_minor = 0`,
    detail: 'a zero-value ledger entry records nothing and should not exist',
    severity: 'WARN',
  },
];

async function domainProblems(db: Db, tables: Set<string>): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const check of CHECKS) {
    if (check.needs?.some((t) => !tables.has(t))) continue;
    let count: number;
    try {
      const { rows } = await db.query<{ c: string }>(check.sql);
      count = Number(rows[0]!.c);
    } catch (e) {
      problems.push({
        check: check.name,
        count: -1,
        detail: `the check itself failed to run: ${e instanceof Error ? e.message : String(e)}`,
        severity: 'WARN',
      });
      continue;
    }
    if (count > 0) {
      problems.push({
        check: check.name,
        count,
        detail: check.detail,
        severity: check.severity ?? 'FATAL',
      });
    }
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printReport(r: Report): void {
  console.log(`\n  ${r.target}`);
  console.log(`  PostgreSQL ${r.serverVersion}   encoding ${r.encoding}   lc_ctype ${r.ctype}`);
  console.log(
    `  extensions: ${r.extensions.length === 0 ? 'none' : r.extensions.join(', ')}` +
      `   migrations applied: ${r.migrationsApplied}`,
  );

  const nonEmpty = r.tables.filter((t) => t.rows > 0);
  console.log(`\n  ${nonEmpty.length} of ${r.tables.length} tables hold data, ${r.totalRows} rows in total\n`);
  console.log(`  ${pad('table', 32)}${pad('rows', 9)}${pad('oldest', 21)}newest`);
  console.log(`  ${'-'.repeat(78)}`);
  for (const t of nonEmpty) {
    console.log(
      `  ${pad(t.table, 32)}${pad(String(t.rows), 9)}` +
        `${pad((t.oldest ?? '').slice(0, 19), 21)}${(t.newest ?? '').slice(0, 19)}`,
    );
  }
}

function printProblems(r: Report): void {
  if (r.problems.length === 0) {
    console.log(`\n  No structural problems found.\n`);
    return;
  }
  console.log(`\n  ${r.problems.length} problem(s):\n`);
  for (const p of r.problems) {
    console.log(`  [${p.severity}] ${p.check} — ${p.count === -1 ? 'not run' : `${p.count} row(s)`}`);
    console.log(`           ${p.detail}`);
  }
  console.log('');
}

function printComparison(a: Report, b: Report): void {
  console.log(`\n  SOURCE  ${a.target}    (PostgreSQL ${a.serverVersion})`);
  console.log(`  TARGET  ${b.target}    (PostgreSQL ${b.serverVersion})\n`);

  const names = [...new Set([...a.tables, ...b.tables].map((t) => t.table))].sort();
  const byName = (r: Report): Map<string, TableStat> => new Map(r.tables.map((t) => [t.table, t]));
  const A = byName(a);
  const B = byName(b);

  console.log(`  ${pad('table', 32)}${pad('source', 10)}${pad('target', 10)}${pad('diff', 8)}fingerprint`);
  console.log(`  ${'-'.repeat(78)}`);

  let differences = 0;
  for (const name of names) {
    const sa = A.get(name);
    const sb = B.get(name);
    const ra = sa?.rows ?? -1;
    const rb = sb?.rows ?? -1;
    const same = ra === rb;
    const fp =
      sa?.fingerprint && sb?.fingerprint
        ? sa.fingerprint === sb.fingerprint
          ? 'match'
          : 'DIFFER'
        : '';
    if (!same || fp === 'DIFFER') differences += 1;
    if (ra === 0 && rb === 0) continue;
    console.log(
      `  ${pad(name, 32)}${pad(ra < 0 ? 'absent' : String(ra), 10)}` +
        `${pad(rb < 0 ? 'absent' : String(rb), 10)}` +
        `${pad(same ? 'ok' : String(rb - ra), 8)}${fp}`,
    );
  }

  console.log('');
  if (differences === 0) {
    console.log(`  The two databases agree on every table.\n`);
  } else {
    console.log(`  ${differences} table(s) disagree. The copy is NOT faithful.\n`);
  }

  if (!wantFingerprint) {
    console.log(`  Row counts only. Add --fingerprint to compare the identifiers themselves —\n` +
      `  two tables can hold the same number of different rows.\n`);
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Refusing to guess which database to inspect.');
    process.exit(2);
  }
  if (url === 'pglite') {
    console.error('DATABASE_URL=pglite is the in-process development database; there is nothing to validate.');
    process.exit(2);
  }

  const source = await collect(url);

  if (compareUrl) {
    const target = await collect(compareUrl);
    if (wantJson) {
      console.log(JSON.stringify({ source, target }, null, 2));
    } else {
      printComparison(source, target);
      console.log('  SOURCE problems:');
      printProblems(source);
      console.log('  TARGET problems:');
      printProblems(target);
    }
    const fatal = [...source.problems, ...target.problems].some((p) => p.severity === 'FATAL');
    const mismatched = source.tables.some(
      (t) => (target.tables.find((x) => x.table === t.table)?.rows ?? -1) !== t.rows,
    );
    process.exit(fatal || mismatched ? 1 : 0);
  }

  if (wantJson) {
    console.log(JSON.stringify(source, null, 2));
  } else {
    printReport(source);
    printProblems(source);
  }
  process.exit(source.problems.some((p) => p.severity === 'FATAL') ? 1 : 0);
}

await main();
