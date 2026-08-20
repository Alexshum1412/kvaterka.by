import { db, env, PGLITE_URL, ready } from '@/server/runtime.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Liveness and readiness, in one endpoint that answers honestly.
 *
 * There was no health endpoint at all, which is the sort of gap that only
 * hurts once: a deployment platform decides a container is healthy because it
 * answered a TCP connect, sends it traffic, and every request fails on a
 * database that is not there. MVP_RELEASE_CHECKLIST.md names this under
 * Operations and it has been unchecked since the first commit.
 *
 * TWO THINGS IT DELIBERATELY DOES.
 *
 * It touches the database. A health check that only proves the process is
 * running is a check that a load balancer can already do by opening a socket;
 * the interesting failure is a live process with a dead dependency, and that
 * is the one this catches.
 *
 * And it reports the background jobs. A queue that stopped draining three
 * weeks ago looks exactly like one that never had anything to send, and this
 * platform's scheduler is an external caller — so "did the sweep run?" is a
 * question nothing else in the product can answer. `job_run` already records
 * it; this surfaces it where a monitor can see it.
 *
 * WHAT IT NEVER RETURNS: a connection string, a credential, a hostname, a
 * user, a count of people. An unauthenticated endpoint is read by anyone who
 * finds it, so it says whether the platform works, never anything about who is
 * using it.
 */
export async function GET(): Promise<Response> {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  try {
    const connection = await ready();
    const started = Date.now();
    await connection.query('SELECT 1');
    checks['database'] = {
      ok: true,
      latencyMs: Date.now() - started,
      // Which engine, not where it lives. `pglite` in production is itself a
      // misconfiguration worth seeing on a dashboard.
      driver: env().DATABASE_URL === PGLITE_URL ? 'pglite' : 'postgres',
    };
  } catch (error) {
    healthy = false;
    checks['database'] = {
      ok: false,
      // The message can name a host or a role, so only the class is reported.
      error: error instanceof Error ? error.constructor.name : 'unknown',
    };
  }

  if (healthy) {
    try {
      const connection = db();
      const { rows } = await connection.query<{
        job_name: string;
        status: string;
        finished_at: string | null;
        started_at: string;
      }>(
        `SELECT DISTINCT ON (job_name) job_name, status, started_at, finished_at
           FROM job_run ORDER BY job_name, started_at DESC`,
      );
      checks['jobs'] = rows.map((r) => ({
        job: r.job_name,
        status: r.status,
        lastRunAt: r.finished_at ?? r.started_at,
      }));

      const { rows: backlog } = await connection.query<{ channel: string; c: string }>(
        `SELECT channel, count(*)::text AS c FROM notification
          WHERE status IN ('PENDING','SENDING') GROUP BY channel`,
      );
      checks['notificationBacklog'] = Object.fromEntries(backlog.map((r) => [r.channel, Number(r.c)]));
    } catch {
      // A failure here is not a reason to report the platform unhealthy: the
      // database answered, so the site works. It is a reason to say nothing
      // rather than to guess.
      checks['jobs'] = null;
    }
  }

  return Response.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    {
      status: healthy ? 200 : 503,
      // Never cached: a cached health check is a health check that reports the
      // state of some earlier minute.
      headers: { 'cache-control': 'no-store' },
    },
  );
}
