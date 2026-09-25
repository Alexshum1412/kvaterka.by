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
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (fingerprint) DO UPDATE
         SET count = error_event.count + 1, last_seen = now(), message = EXCLUDED.message`,
      [errorFingerprint(input.source, message, path), input.source, message, path],
    );
  } catch {
    // The database being the thing that failed is exactly when this runs.
  }
}
