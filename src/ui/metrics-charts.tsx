'use client';

import { useCallback, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { Money } from '@/ui/primitives.tsx';

/**
 * The analytics dashboard's numbers.
 *
 * Two clocks run at once here, on purpose: `usersByStatus` and
 * `listingsByStatus` are the platform as it stands right now, unaffected by
 * the day toggle — a landlord who published two years ago does not vanish
 * from the count because the reader chose "30 days". Everything else
 * (bookings, GMV, fee revenue, both day series) is scoped to the window,
 * because those are activity, not standing. Mixing the two into one number
 * would misreport one of them; the stat-tile hints below say which is which
 * so nobody has to guess from the shape of the query.
 */
export interface AnalyticsOverview {
  windowDays: number;
  usersByStatus: Record<string, number>;
  listingsByStatus: Record<string, number>;
  bookingsByStatus: Record<string, number>;
  /** Decimal-string minor units (kopecks). Never parsed as a JS number. */
  gmvMinor: string;
  /** Decimal-string minor units (kopecks). Never parsed as a JS number. */
  feeRevenueMinor: string;
  signupsByDay: { day: string; total: string }[];
  bookingsByDay: { day: string; total: string }[];
}

type Days = 30 | 90;

const USER_STATUS_ORDER = ['ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED'] as const;
const LISTING_STATUS_ORDER = ['DRAFT', 'PENDING_MODERATION', 'PUBLISHED', 'PAUSED', 'REJECTED', 'ARCHIVED'] as const;
const BOOKING_STATUS_ORDER = [
  'INQUIRY',
  'REQUESTED',
  'OFFER_PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'COMPLETION_PENDING',
  'COMPLETED',
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
  'NOT_TAKEN_PLACE',
  'CANCELLED_BY_TENANT',
  'CANCELLED_BY_LANDLORD',
  'DISPUTED',
] as const;

/** A status this deployment's schema grew that the fixed order above does not know about yet. */
function humanize(raw: string): string {
  return raw
    .toLowerCase()
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

interface BarRow {
  key: string;
  label: string;
  count: number;
}

/** The canonical order first (as zero when absent, so an empty status is a visible fact, not a missing row), then anything the map holds that the order doesn't know about. */
function buildRows(counts: Record<string, number>, order: readonly string[], labels: Record<string, string>): BarRow[] {
  const rows: BarRow[] = order.map((key) => ({ key, label: labels[key] ?? humanize(key), count: counts[key] ?? 0 }));
  const known = new Set<string>(order);
  for (const key of Object.keys(counts)) {
    if (!known.has(key)) rows.push({ key, label: labels[key] ?? humanize(key), count: counts[key] ?? 0 });
  }
  return rows;
}

interface DayPoint {
  day: string;
  value: number;
}

/**
 * Every calendar day in the window, ending today — days absent from `rows`
 * become an explicit 0, never skipped. A gap in a trend line is data too.
 */
function dailySeries(rows: { day: string; total: string }[], days: number): DayPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, Number(r.total)]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, value: byDay.get(key) ?? 0 });
  }
  return out;
}

function sumValues(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

export function MetricsCharts({ initialData, initialDays }: { initialData: AnalyticsOverview; initialDays: Days }) {
  const t = useTranslations('StaffMetrics');
  const locale = useLocale();

  const [days, setDays] = useState<Days>(initialDays);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: Days) => {
      setLoading(true);
      setError(null);
      try {
        const fresh = await api.get<AnalyticsOverview>(`/admin/analytics/overview?days=${target}`);
        setData(fresh);
        setDays(target);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('loadError'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  const numberFmt = new Intl.NumberFormat(locale);
  const axisFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const tooltipFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });

  const userLabels = t.raw('statusUser') as Record<string, string>;
  const listingLabels = t.raw('statusListing') as Record<string, string>;
  const bookingLabels = t.raw('statusBooking') as Record<string, string>;

  const userRows = buildRows(data.usersByStatus, USER_STATUS_ORDER, userLabels);
  const listingRows = buildRows(data.listingsByStatus, LISTING_STATUS_ORDER, listingLabels);
  const bookingRows = buildRows(data.bookingsByStatus, BOOKING_STATUS_ORDER, bookingLabels);

  const totalUsers = sumValues(data.usersByStatus);
  const publishedListings = data.listingsByStatus['PUBLISHED'] ?? 0;
  const bookingsInRange = sumValues(data.bookingsByStatus);

  const signups = dailySeries(data.signupsByDay, days);
  const bookingsDaily = dailySeries(data.bookingsByDay, days);

  return (
    <div className="mc">
      <div className="mc__toolbar">
        <div className="mc__range" role="group" aria-label={t('rangeLabel')}>
          {([30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={d === days ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              aria-pressed={d === days}
              disabled={loading}
              onClick={() => {
                if (d !== days) void load(d);
              }}
            >
              {t(d === 30 ? 'range30' : 'range90')}
            </button>
          ))}
          {loading && <span className="mc__refreshing">{t('refreshing')}</span>}
        </div>
        <p className="mc__rangeNote">{t('rangeNote')}</p>
      </div>

      {error && (
        <p className="mc__banner" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(days)}>
            {t('retry')}
          </button>
        </p>
      )}

      <div className={loading ? 'mc__body is-loading' : 'mc__body'}>
        <div className="mc__tiles">
          <StatTile label={t('stats.users')} hint={t('stats.usersHint')} value={numberFmt.format(totalUsers)} />
          <StatTile label={t('stats.gmv')} hint={t('stats.gmvHint')} value={<Money minor={data.gmvMinor} />} />
          <StatTile label={t('stats.feeRevenue')} hint={t('stats.feeRevenueHint')} value={<Money minor={data.feeRevenueMinor} />} />
          <StatTile
            label={t('stats.publishedListings')}
            hint={t('stats.publishedListingsHint')}
            value={numberFmt.format(publishedListings)}
          />
          <StatTile label={t('stats.bookings')} hint={t('stats.bookingsHint')} value={numberFmt.format(bookingsInRange)} />
        </div>

        <div className="mc__panels">
          <BarPanel title={t('sections.users')} rows={userRows} numberFmt={numberFmt} />
          <BarPanel title={t('sections.listings')} rows={listingRows} numberFmt={numberFmt} />
          <BarPanel title={t('sections.bookings')} rows={bookingRows} numberFmt={numberFmt} />
        </div>

        <div className="mc__panels mc__panels--trends">
          <TrendPanel
            title={t('sections.signupsTrend')}
            totalLabel={t('trend.totalLabel')}
            series={signups}
            numberFmt={numberFmt}
            axisFmt={axisFmt}
            tooltip={(point) => t('trend.tooltip', { date: tooltipFmt.format(new Date(point.day)), count: point.value })}
            tone="a"
          />
          <TrendPanel
            title={t('sections.bookingsTrend')}
            totalLabel={t('trend.totalLabel')}
            series={bookingsDaily}
            numberFmt={numberFmt}
            axisFmt={axisFmt}
            tooltip={(point) => t('trend.tooltip', { date: tooltipFmt.format(new Date(point.day)), count: point.value })}
            tone="b"
          />
        </div>
      </div>

      <style>{`
        .mc { display: grid; gap: var(--space-5); }

        .mc__toolbar { display: grid; gap: var(--space-2); }
        .mc__range { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .mc__refreshing { font-size: var(--text-xs); color: var(--text-tertiary); }
        .mc__rangeNote { font-size: var(--text-xs); color: var(--text-tertiary); max-width: 60ch; line-height: 1.5; }

        .mc__banner {
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-3) var(--space-4);
          background: var(--error-soft); color: var(--error);
          border-radius: var(--radius-sm); font-size: var(--text-sm); line-height: 1.5;
        }
        .mc__banner > svg { flex: 0 0 auto; }
        .mc__banner > span { flex: 1 1 auto; min-width: 0; }

        .mc__body { display: grid; gap: var(--space-5); transition: opacity 160ms ease; }
        .mc__body.is-loading { opacity: 0.6; }

        .mc__tiles {
          display: grid; gap: var(--space-3);
          grid-template-columns: repeat(auto-fill, minmax(12.5rem, 1fr));
        }
        .mc__tile {
          display: grid; gap: 0.2rem; align-content: start;
          padding: var(--space-4);
          background: var(--surface); border-radius: var(--radius-md);
        }
        .mc__tileLabel { font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary); }
        .mc__tileValue { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
        .mc__tileHint { font-size: var(--text-2xs); color: var(--text-tertiary); line-height: 1.4; }

        .mc__panels {
          display: grid; gap: var(--space-3);
          grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
        }
        .mc__panel { padding: var(--space-4); background: var(--surface); border-radius: var(--radius-md); }
        .mc__panelTitle { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-3); }

        .mc__bars { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
        .mc__barRow { display: grid; grid-template-columns: minmax(6.5rem, auto) 1fr auto; align-items: center; gap: var(--space-2); }
        .mc__barLabel { font-size: var(--text-xs); color: var(--text-secondary); }
        .mc__barTrack { display: block; height: 0.5rem; border-radius: var(--radius-full); background: var(--surface-sunken); overflow: hidden; }
        .mc__barFill { display: block; height: 100%; border-radius: var(--radius-full); background: var(--primary); }
        .mc__barValue { font-size: var(--text-xs); color: var(--text-secondary); min-width: 2.5ch; text-align: right; }

        .mc__panelHead { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
        .mc__panelTotal { display: flex; align-items: baseline; gap: 0.3rem; font-size: var(--text-xs); color: var(--text-tertiary); }
        .mc__panelTotal strong { font-size: var(--text-sm); color: var(--text-primary); font-weight: 650; }

        .mc__chart { display: block; width: 100%; height: 6.5rem; overflow: visible; }
        .mc__chartBaseline { stroke: var(--border); stroke-width: 1; }
        .mc__chartBar--a { fill: var(--primary); }
        .mc__chartBar--b { fill: var(--success); }
        .mc__chartAxis { display: flex; justify-content: space-between; font-size: var(--text-2xs); color: var(--text-tertiary); margin-top: 0.3rem; }

        @media (max-width: 560px) {
          .mc__barRow { grid-template-columns: minmax(5.5rem, auto) 1fr auto; }
        }
      `}</style>
    </div>
  );
}

function StatTile({ label, hint, value }: { label: string; hint: string; value: React.ReactNode }) {
  return (
    <div className="mc__tile">
      <span className="mc__tileLabel">{label}</span>
      <span className="mc__tileValue numeric">{value}</span>
      <span className="mc__tileHint">{hint}</span>
    </div>
  );
}

function BarPanel({ title, rows, numberFmt }: { title: string; rows: BarRow[]; numberFmt: Intl.NumberFormat }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="mc__panel">
      <h2 className="mc__panelTitle">{title}</h2>
      <ul className="mc__bars">
        {rows.map((r) => (
          <li key={r.key} className="mc__barRow">
            <span className="mc__barLabel">{r.label}</span>
            <span className="mc__barTrack" aria-hidden="true">
              <span
                className="mc__barFill"
                style={{ width: r.count > 0 ? `${Math.max(3, (r.count / max) * 100)}%` : '0%' }}
              />
            </span>
            <span className="mc__barValue numeric">{numberFmt.format(r.count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TrendPanel({
  title,
  totalLabel,
  series,
  numberFmt,
  axisFmt,
  tooltip,
  tone,
}: {
  title: string;
  totalLabel: string;
  series: DayPoint[];
  numberFmt: Intl.NumberFormat;
  axisFmt: Intl.DateTimeFormat;
  tooltip: (point: DayPoint) => string;
  tone: 'a' | 'b';
}) {
  const max = Math.max(1, ...series.map((s) => s.value));
  const total = series.reduce((a, s) => a + s.value, 0);
  const W = 600;
  const H = 104;
  const barW = W / series.length;
  const gap = barW > 6 ? 1.2 : 0.4;

  return (
    <section className="mc__panel">
      <div className="mc__panelHead">
        <h2 className="mc__panelTitle" style={{ marginBottom: 0 }}>
          {title}
        </h2>
        <span className="mc__panelTotal">
          {totalLabel} <strong className="numeric">{numberFmt.format(total)}</strong>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mc__chart" role="img" aria-label={title} preserveAspectRatio="none">
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} className="mc__chartBaseline" />
        {series.map((s, i) => {
          const h = s.value === 0 ? 0 : Math.max(2, (s.value / max) * (H - 10));
          const x = i * barW + gap / 2;
          const w = Math.max(0.4, barW - gap);
          const y = H - 1 - h;
          return (
            <rect key={s.day} x={x} y={y} width={w} height={h} className={`mc__chartBar--${tone}`}>
              <title>{tooltip(s)}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mc__chartAxis">
        <span>{axisFmt.format(new Date(series[0]!.day))}</span>
        <span>{axisFmt.format(new Date(series[series.length - 1]!.day))}</span>
      </div>
    </section>
  );
}
