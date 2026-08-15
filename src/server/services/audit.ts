/**
 * Audit logging (spec §56).
 *
 * Written inside the same transaction as the change it describes, so the log
 * and the fact can never disagree: if the business change rolls back, so does
 * its audit row, and if the audit write fails the change does not commit.
 */

import type { Sql } from '../db/sql.ts';

export interface AuditEntry {
  readonly actorUserId?: string | null;
  readonly actorRole?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly changes?: Record<string, unknown> | null;
  readonly reason?: string | null;
  readonly correlationId?: string | null;
  readonly source?: 'web' | 'api' | 'job' | 'admin' | 'system';
  readonly ipHash?: Buffer | null;
}

export async function writeAudit(tx: Sql, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (actor_user_id, actor_role, action, target_type, target_id, changes, reason, correlation_id, source, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorUserId ?? null,
      entry.actorRole ?? null,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.changes ? JSON.stringify(entry.changes) : null,
      entry.reason ?? null,
      entry.correlationId ?? null,
      entry.source ?? 'web',
      entry.ipHash ?? null,
    ],
  );
}

/** Diff helper so audit rows carry before/after rather than whole snapshots. */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}
