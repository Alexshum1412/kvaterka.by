import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { MetricsCharts, type AnalyticsOverview } from '@/ui/metrics-charts.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffMetrics');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The analytics dashboard.
 *
 * Read-only, and read straight from the tables rather than through a
 * service — there is no service for this, `GET /admin/analytics/overview`
 * queries the database directly (see `src/server/api/routes/admin.ts`), and
 * this page's initial render mirrors that same query rather than making a
 * loopback HTTP call to its own API. The 30/90-day toggle below re-fetches
 * through that real endpoint via `api.get`, so the two paths (first paint,
 * later toggles) never have a chance to compute the numbers differently.
 *
 * `usersByStatus` and `listingsByStatus` are NOT scoped to the window — they
 * are the platform as it stands today — while bookings, GMV, fee revenue and
 * both day series are. `MetricsCharts` carries that distinction into the
 * stat-tile hints rather than hiding it.
 */
const WINDOW_DAYS = 30;

interface CountRow {
  status: string;
  total: string;
}
interface SumRow {
  total: string | null;
}
interface DayRow {
  day: string;
  total: string;
}

async function loadOverview(days: number): Promise<AnalyticsOverview> {
  const database = await ready();
  // `days` is a fixed server constant (never user input) — safe to interpolate
  // into the interval literal, exactly as the route handler it mirrors does.
  const since = `now() - interval '${days} days'`;

  const [users, listings, bookingsByStatus, gmv, feeRevenue, signupSeries, bookingSeries] = await Promise.all([
    database.query<CountRow>(`SELECT status, count(*)::text AS total FROM app_user WHERE deleted_at IS NULL GROUP BY status`),
    database.query<CountRow>(`SELECT status, count(*)::text AS total FROM property WHERE deleted_at IS NULL GROUP BY status`),
    database.query<CountRow>(
      `SELECT status, count(*)::text AS total FROM booking WHERE created_at >= ${since} GROUP BY status`,
    ),
    database.query<SumRow>(
      `SELECT sum(total_expected_minor)::text AS total FROM booking WHERE status = 'COMPLETED' AND created_at >= ${since}`,
    ),
    database.query<SumRow>(`SELECT sum(fee_minor)::text AS total FROM service_fee WHERE accrued_at >= ${since}`),
    database.query<DayRow>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::text AS total
         FROM app_user WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`,
    ),
    database.query<DayRow>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::text AS total
         FROM booking WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`,
    ),
  ]);

  return {
    windowDays: days,
    usersByStatus: Object.fromEntries(users.rows.map((r) => [r.status, Number(r.total)])),
    listingsByStatus: Object.fromEntries(listings.rows.map((r) => [r.status, Number(r.total)])),
    bookingsByStatus: Object.fromEntries(bookingsByStatus.rows.map((r) => [r.status, Number(r.total)])),
    gmvMinor: gmv.rows[0]?.total ?? '0',
    feeRevenueMinor: feeRevenue.rows[0]?.total ?? '0',
    signupsByDay: signupSeries.rows,
    bookingsByDay: bookingSeries.rows,
  };
}

export default async function StaffMetricsPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/metrics'), locale });
  // 404, not 403 — consistent with every other staff surface: whether an
  // analytics console exists is not something an ordinary account needs
  // confirmed.
  if (!can(user!.roles, 'analytics.view')) notFound();

  const t = await getTranslations('StaffMetrics');
  const overview = await loadOverview(WINDOW_DAYS);

  return (
    <StaffShell roles={user!.roles} withheldRoles={user!.withheldRoles} current="/staff/metrics" title={t('title')} subtitle={t('subtitle')}>
      <MetricsCharts initialData={overview} initialDays={WINDOW_DAYS} />
    </StaffShell>
  );
}
