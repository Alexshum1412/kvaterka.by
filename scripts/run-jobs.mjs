#!/usr/bin/env node
/**
 * The scheduler.
 *
 * Everything scheduled in this platform — draining the notification outbox,
 * expiring unanswered requests, opening completion windows, publishing reviews,
 * purging what may be purged — is an HTTP route, deliberately. A Next.js
 * deployment may run as several short-lived instances, so an in-process timer
 * either never fires or fires N times; a route with a credential is honest
 * about who did the work and lands in `job_run` where it can be audited.
 *
 * What was missing was anything that CALLS those routes. This is that thing,
 * and it is intentionally the smallest possible program: no dependencies, no
 * framework, plain Node and fetch. Point a cron, a systemd timer, a Kubernetes
 * CronJob or the bundled GitHub Actions workflow at it.
 *
 *   BASE_URL=https://kvaterka.by JOB_RUNNER_TOKEN=… node scripts/run-jobs.mjs
 *
 * It prints one JSON object per job to stdout — structured, greppable, and
 * with no secret in it — and exits non-zero if any job failed, so that a
 * silent scheduler failure becomes a visible one.
 */

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.JOB_RUNNER_TOKEN;
const TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 120_000);

/**
 * Order matters, mildly.
 *
 * The lifecycle sweep ENQUEUES notifications — expired requests, opened
 * completion windows, published reviews — so running it before the delivery
 * drain means what it produces goes out in the same tick instead of waiting
 * for the next one. Retention runs last because it is the only one that can
 * destroy anything, and it should not race the two that are writing.
 */
const JOBS = [
  { name: 'lifecycle', path: '/api/admin/lifecycle/run' },
  { name: 'notifications', path: '/api/admin/notifications/run' },
  { name: 'retention', path: '/api/admin/retention/run' },
];

if (!TOKEN) {
  // Fail loudly rather than running three unauthenticated requests and
  // reporting three 401s as if the jobs had been attempted.
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'JOB_RUNNER_TOKEN is not set; the scheduler has no credential and cannot run any job.',
    }),
  );
  process.exit(2);
}

let failed = 0;

for (const job of JOBS) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${job.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The header the router reads. Never `authorization`, which carries
        // session tokens — a credential that could be mistaken for a session
        // would eventually be treated as one.
        'x-job-token': TOKEN,
      },
      body: '{}',
      signal: controller.signal,
    });

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) failed += 1;

    console.log(
      JSON.stringify({
        level: ok ? 'info' : 'error',
        job: job.name,
        status: response.status,
        durationMs: Date.now() - startedAt,
        // The job's own report: what it did, or the note explaining that
        // another runner already held the lock and it did nothing.
        result: body,
      }),
    );
  } catch (error) {
    failed += 1;
    console.log(
      JSON.stringify({
        level: 'error',
        job: job.name,
        durationMs: Date.now() - startedAt,
        error: error?.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : String(error?.message ?? error),
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

/* A non-zero exit is the only thing most schedulers look at. Losing it means
   a queue that stopped draining three weeks ago looks exactly like one that
   drained fine, which is the failure this whole file exists to prevent. */
process.exit(failed > 0 ? 1 : 0);
