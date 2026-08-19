/**
 * The machine principal: how a scheduler proves it is the scheduler.
 *
 * WHY THIS EXISTS AT ALL
 *
 * `rbac.ts` has always described `lifecycle.run`, `retention.run` and
 * `notifications.run` as machine credentials — "a cron calls it" is written
 * beside the permission. They were nevertheless granted to ADMIN, because a
 * human with an admin session was the only principal the product had.
 *
 * DEC-054 then made ADMIN a role that is WITHHELD until a second factor is
 * satisfied. That is correct for people and fatal for machines: a cron cannot
 * read a six-digit code off somebody's phone. So the three jobs that the whole
 * platform depends on — delivering notifications, expiring stale requests,
 * opening completion windows, purging what may be purged — became reachable
 * only by a human who had just typed a TOTP. In practice that means they never
 * ran. The 2FA slice closed a security hole and silently disabled the
 * background half of the product; this module is the other half of that change.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 * It is not a user. There is no row in `app_user`, no session, no roles. A
 * machine principal cannot be granted a role, so no future edit to the ADMIN
 * permission list can widen what a scheduler may do. The set below is the
 * entire universe of what this credential authorises, written out by hand:
 *
 *   - it can run three jobs;
 *   - it can read nothing;
 *   - it can decide nothing;
 *   - it can never reach a passport, a dispute, a ledger or a role grant.
 *
 * That containment is the point. A leaked scheduler token lets an attacker run
 * a job early. It does not let them read anything, and every job it can run is
 * idempotent and guarded by the `job_run` mutex, so running it early is close
 * to harmless. Compare with the alternative that was tempting — issuing the
 * cron an ADMIN account exempt from 2FA — where the same leak hands over the
 * verification console.
 *
 * FAIL CLOSED
 *
 * With `JOB_RUNNER_TOKEN` unset there is no machine principal at all and every
 * job route answers exactly as it did before. A deployment that forgets to set
 * it does not get an open door; it gets a queue that does not drain, which is
 * visible in the backlog panel.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Permission } from '../auth/rbac.ts';

/**
 * The header a scheduler sends. Deliberately NOT `authorization`, which
 * `readSessionToken` already consumes: a token that could be mistaken for a
 * session token would eventually be treated as one.
 */
export const JOB_TOKEN_HEADER = 'x-job-token';

/**
 * Short enough to type into a secret store, long enough that guessing it is
 * not a strategy. Rejected at startup rather than at first use, because a
 * deployment discovering its scheduler token is too weak at 03:00 — the hour
 * these jobs run — is the worst possible time to find out.
 */
export const MIN_JOB_TOKEN_LENGTH = 32;

/**
 * Everything a machine may do. Written out rather than derived from a role,
 * so that widening a role can never widen this.
 *
 * None of these appear in `STEP_UP_PERMISSIONS`, and that is not a
 * coincidence: step-up means "prove possession of a second factor in the last
 * fifteen minutes", which a machine can never do. If a permission ever needs
 * both a machine runner and step-up, the design is wrong, not the check.
 */
export const MACHINE_PERMISSIONS: readonly Permission[] = [
  'lifecycle.run',
  'retention.run',
  'notifications.run',
];

export interface MachinePrincipal {
  /** For the audit trail and the job report. Never a token, never a secret. */
  readonly name: string;
}

export const SCHEDULER: MachinePrincipal = { name: 'scheduler' };

export function machineCan(permission: Permission): boolean {
  return MACHINE_PERMISSIONS.includes(permission);
}

/**
 * Constant-time comparison of two secrets of possibly different length.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and the naive
 * repair — comparing lengths first and returning early — leaks the length of
 * the real token through timing. Hashing both sides to a fixed width would
 * also work; comparing against a padded copy of equal length is simpler and
 * has no dependency on a digest choice.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const width = Math.max(a.length, b.length);
  const padded = (buf: Buffer): Buffer => {
    const out = Buffer.alloc(width);
    buf.copy(out);
    return out;
  };
  // The length equality is folded into the result rather than short-circuited.
  return timingSafeEqual(padded(a), padded(b)) && a.length === b.length;
}

/**
 * Resolve the machine principal for a request, or null.
 *
 * `expected` is passed in rather than read from `process.env` here so that the
 * router stays testable and so that configuration is validated once at
 * startup, in `runtime.ts`, like every other setting.
 */
export function resolveMachine(
  headers: Readonly<Record<string, string>>,
  expected: string | undefined,
): MachinePrincipal | null {
  if (!expected || expected.length < MIN_JOB_TOKEN_LENGTH) return null;
  const presented = headers[JOB_TOKEN_HEADER];
  if (!presented) return null;
  return secretsMatch(presented, expected) ? SCHEDULER : null;
}
