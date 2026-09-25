/**
 * Error tracking without a third party (DEC-086).
 *
 * The API's unexpected failures used to go to stdout as one JSON line and
 * nowhere else, and a crash in the browser went nowhere at all. Both now land
 * in `error_event`, deduplicated by fingerprint, where the lifecycle watchdog
 * (watchdog.ts) notices new ones and tells the administrators, and the staff
 * overview lists them. No request body, user id or IP is ever recorded.
 *
 * ponytail: a table and a counter, not Sentry — no stack symbolication, no
 * release tracking. A hosted tracker is the upgrade once one is chosen; this
 * is what can exist without an account anywhere.
 */

import { createHash } from 'node:crypto';
import type { Sql } from '../db/sql.ts';

export type ErrorSource = 'API' | 'CLIENT';

/** Ids, numbers and hex blobs vary per occurrence; the failure does not. */
function normalise(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b[0-9a-f]{16,}\b/gi, ':hex')
    .replace(/\d+/g, ':n');
}

export function errorFingerprint(source: ErrorSource, message: string, path: string | null): string {
  return createHash('sha256')
    .update(`${source}\n${normalise(message)}\n${normalise(path ?? '')}`)
    .digest('hex')
    .slice(0, 40);
}

/**
 * How many new CLIENT fingerprints a rolling day may add. The endpoint is
 * anonymous and its rate limits are only as good as a client-supplied header,
 * so what one visitor can write must not be unbounded. API errors are not held
 * to it, and neither are repeats of a failure already on file.
 */
export const MAX_NEW_CLIENT_ERRORS_PER_DAY = 200;

/** Never throws: recording a failure must not become a second failure. */
export async function recordError(
  sql: Sql,
  input: { source: ErrorSource; message: string; path?: string | null },
): Promise<void> {
  const message = input.message.trim().slice(0, 500) || '(no message)';
  const path = input.path ? input.path.split('?')[0]!.slice(0, 300) : null;
  try {
    await sql.query(
      `INSERT INTO error_event (fingerprint, source, message, path)
       SELECT $1::text, $2::text, $3::text, $4::text
        WHERE $2::text <> 'CLIENT'
           OR EXISTS (SELECT 1 FROM error_event WHERE fingerprint = $1::text)
           OR (SELECT count(*) FROM error_event
                WHERE source = 'CLIENT' AND first_seen > now() - interval '1 day') < $5::int
       ON CONFLICT (fingerprint) DO UPDATE
         SET count = error_event.count + 1, last_seen = now(), message = EXCLUDED.message`,
      [errorFingerprint(input.source, message, path), input.source, message, path, MAX_NEW_CLIENT_ERRORS_PER_DAY],
    );
  } catch {
    // The database being the thing that failed is exactly when this runs.
  }
}

export interface RecentError {
  readonly fingerprint: string;
  readonly source: ErrorSource;
  readonly message: string;
  readonly path: string | null;
  readonly count: number;
  readonly last_seen: Date;
}

/**
 * What the staff overview shows: the most recent `perSource` rows of each
 * source, server errors first. One list ordered by recency alone let a burst of
 * browser reports push every server error off the page. Within CLIENT the
 * ranking is by count first — a crash many visitors hit outranks a pile of
 * one-off reports.
 */
export async function listRecentErrors(sql: Sql, perSource = 10): Promise<RecentError[]> {
  const { rows } = await sql.query<RecentError>(
    `SELECT fingerprint, source, message, path, count, last_seen FROM (
        SELECT *, row_number() OVER (
                 PARTITION BY source
                 ORDER BY CASE WHEN source = 'CLIENT' THEN count ELSE 0 END DESC, last_seen DESC) AS rn
          FROM error_event
      ) ranked
      WHERE rn <= $1
      ORDER BY (source = 'API') DESC, last_seen DESC`,
    [perSource],
  );
  return rows;
}
