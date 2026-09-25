/**
 * The watchdog (DEC-086): invariants that should never be false in a healthy
 * deployment, checked by the lifecycle job, reported to administrators.
 *
 * MVP_RELEASE_CHECKLIST listed "Alerts on failed fee accrual, stuck
 * completions, notification backlog" and "nothing watches" `job_run` or the
 * backlog. Each check below is a query for a state the rest of the system
 * promises cannot persist; a non-zero count is the alert. Read-only — it
 * diagnoses, it never repairs.
 */

import type { Sql } from '../db/sql.ts';
import type { NotificationService } from './notification-service.ts';

export type AlertKind =
  | 'FEE_MISSING'
  | 'COMPLETION_STUCK'
  | 'STAY_NOT_CLOSED'
  | 'NOTIFICATION_BACKLOG'
  | 'NOTIFICATION_FAILURES'
  | 'JOB_FAILED'
  | 'NEW_ERRORS';

export interface OpsAlert {
  readonly kind: AlertKind;
  readonly count: number;
}

const CHECKS: readonly [AlertKind, string][] = [
  // Every COMPLETED booking accrues a fee in the same transaction
  // (completion.ts: COMPLETED <=> accrueFee). A completed booking without one
  // is money the platform is owed and has no record of.
  [
    'FEE_MISSING',
    `SELECT count(*)::int AS c FROM booking b
      WHERE b.status = 'COMPLETED' AND b.completed_at < now() - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM service_fee f WHERE f.booking_id = b.id)`,
  ],
  // The lifecycle sweep resolves a completion once its deadline passes; a day
  // past it means the sweep is failing on that row, or not running.
  [
    'COMPLETION_STUCK',
    `SELECT count(*)::int AS c FROM booking
      WHERE status = 'COMPLETION_PENDING' AND completion_deadline_at < now() - interval '1 day'`,
  ],
  // A stay whose last night is two days gone should have opened its
  // completion window; while it has not, no fee can ever accrue.
  [
    'STAY_NOT_CLOSED',
    `SELECT count(*)::int AS c FROM booking
      WHERE status IN ('CONFIRMED', 'CHECKED_IN') AND upper(stay_period) < current_date - 2`,
  ],
  [
    'NOTIFICATION_BACKLOG',
    // Two counts, not `status IN (...)`: each half then reads its own partial
    // index (notification_outbox_idx, notification_claimed_idx) instead of the
    // planner falling back to a scan of the whole table (DEC-086).
    `SELECT ((SELECT count(*) FROM notification
               WHERE status = 'PENDING' AND created_at < now() - interval '1 hour')
           + (SELECT count(*) FROM notification
               WHERE status = 'SENDING' AND created_at < now() - interval '1 hour'))::int AS c`,
  ],
  // One person blocking the bot or a bounced address is an ordinary,
  // permanent fact about that recipient. Five in a day is the relay or the
  // bot itself failing — that is the alert.
  [
    'NOTIFICATION_FAILURES',
    `SELECT CASE WHEN c >= 5 THEN c ELSE 0 END AS c FROM (
        SELECT count(*)::int AS c FROM notification
         WHERE status = 'FAILED' AND coalesce(claimed_at, created_at) > now() - interval '1 day'
      ) failed`,
  ],
  // The latest run of each job: failed outright, or still "running" an hour on.
  [
    'JOB_FAILED',
    `SELECT count(*)::int AS c FROM (
        SELECT DISTINCT ON (job_name) status, started_at FROM job_run ORDER BY job_name, started_at DESC
      ) latest
      WHERE status = 'FAILED' OR (status = 'RUNNING' AND started_at < now() - interval '1 hour')`,
  ],
  [
    'NEW_ERRORS',
    `SELECT count(*)::int AS c FROM error_event WHERE first_seen > now() - interval '1 day'`,
  ],
];

export async function checkOperations(sql: Sql): Promise<OpsAlert[]> {
  const alerts: OpsAlert[] = [];
  for (const [kind, query] of CHECKS) {
    const { rows } = await sql.query<{ c: number }>(query);
    const count = Number(rows[0]?.c ?? 0);
    if (count > 0) alerts.push({ kind, count });
  }
  return alerts;
}

/**
 * One notification per alert kind per administrator per day — a stuck state
 * nobody fixes must not become a notification every tick. The payload carries
 * only the kind and a count (notifications leave the platform, LEGAL-015);
 * the detail is behind the staff login.
 */
export async function notifyAdministrators(
  sql: Sql,
  notifications: NotificationService,
  alerts: readonly OpsAlert[],
  now: Date = new Date(),
): Promise<number> {
  if (alerts.length === 0) return 0;
  const { rows: admins } = await sql.query<{ user_id: string }>(
    `SELECT DISTINCT r.user_id FROM user_role r JOIN app_user u ON u.id = r.user_id
      WHERE r.role = 'ADMIN' AND u.deleted_at IS NULL`,
  );
  const day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const { user_id } of admins) {
    for (const alert of alerts) {
      await notifications.enqueue({
        userId: user_id,
        category: 'OPERATIONS',
        dedupeKey: `ops:${alert.kind}:${day}:${user_id}`,
        payload: { alert: alert.kind, count: alert.count },
      });
      sent += 1;
    }
  }
  return sent;
}
