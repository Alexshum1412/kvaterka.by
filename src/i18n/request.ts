/**
 * Per-request message loading for server components.
 *
 * Messages live one file per namespace (`messages/<locale>/<namespace>.json`,
 * each holding `{ "Namespace": { ...keys } }`) rather than one giant
 * `<locale>.json` — deliberately. This codebase's UI is being translated by
 * many agents/contributors working on disjoint features in parallel; a
 * shared flat JSON file is a guaranteed merge conflict (or worse, a silent
 * last-write-wins loss of another namespace's keys) the moment two of them
 * touch it at the same time. One file per namespace means "add a namespace"
 * is "add a file", never "edit a file someone else is also editing".
 *
 * NAMESPACES is the registry: adding UI text under a new namespace means
 * adding one line here (and the matching file, in all three locales) — same
 * shape as how `PATHS` in icons.tsx is a registry, for the same reason.
 *
 * Falls back to the default locale rather than throwing when the resolved
 * locale is somehow outside the known set — a request should render the
 * site in Russian, never a 500, if locale negotiation ever produces
 * something unexpected.
 */
import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { routing } from './routing.ts';

const NAMESPACES = [
  'metadata',
  'layout',
  'header',
  'footer',
  'account',
  'staff-users',
  'staff-metrics',
  'staff-reports',
  'staff-messages',
  'staff-reviews',
  'staff-feature-flags',
  'staff-audit',
  'about',
  'faq',
  'how-it-works',
  'host',
  'host-fees',
  'trust',
  'terms',
  'privacy',
  'support',
  'home',
  'not-found',
  'error',
  'search',
  'listing',
  'listing-detail',
  'login',
  'password-reset',
  'verify-email',
  'booking',
  'trips',
  'favorites',
  'profile',
  'notifications',
  'booking-list',
  'dashboard',
  'dashboard-bookings',
  'dashboard-finance',
  'dashboard-verification',
  'listing-wizard',
  'calendar',
  'chat',
  'moderation',
  'staff-overview',
  'disputes',
  'retention',
  'staff-verification',
  'staff-security',
  'staff-nav',
] as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const files = await Promise.all(
    NAMESPACES.map((ns) =>
      import(`../../messages/${locale}/${ns}.json`).then(
        (m) => m.default as Record<string, unknown>,
        // A namespace file that doesn't exist yet for this locale (mid-build)
        // degrades to "that namespace's keys are missing" rather than a 500.
        () => ({}),
      ),
    ),
  );

  const messages = Object.assign({}, ...files);

  return { locale, messages };
});
