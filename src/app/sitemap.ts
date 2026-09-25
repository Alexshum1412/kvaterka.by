import type { MetadataRoute } from 'next';
import { env, ready } from '@/server/runtime.ts';
import { routing } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

/**
 * The marketing pages, the six city landing pages, and every published
 * listing — each with its Belarusian and English alternates, since each
 * locale is its own canonical page.
 *
 * Listings used to be left out on the theory that enumerating them meant a
 * query per URL. It is one query for all of them, and they are the content
 * people actually search for; leaving crawlers to find them only through
 * /search's first page of results hid most of the inventory.
 *
 * ponytail: one sitemap, capped at 45,000 listings (the protocol's limit is
 * 50,000 URLs per file). A sitemap index split by id range is the upgrade if
 * inventory ever approaches that.
 *
 * Same fail-closed posture as `robots.ts`: nothing is worth listing on a
 * deployment nobody is meant to find yet.
 */
const CITIES = ['Минск', 'Гродно', 'Брест', 'Витебск', 'Гомель', 'Могилёв'];
const MAX_LISTINGS = 45_000;

type Entry = MetadataRoute.Sitemap[number];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!env().SITE_INDEXABLE) return [];

  const base = env().PUBLIC_BASE_URL.replace(/\/$/, '');
  const now = new Date();
  const entry = (path: string, priority: number, changeFrequency: Entry['changeFrequency'], lastModified = now): Entry => ({
    url: `${base}${path}`,
    lastModified,
    changeFrequency,
    priority,
    alternates: {
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, `${base}${l === routing.defaultLocale ? '' : `/${l}`}${path === '/' && l !== routing.defaultLocale ? '' : path}`]),
      ),
    },
  });

  const pages: [string, number, Entry['changeFrequency']][] = [
    ['/', 1, 'daily'],
    ['/search', 0.9, 'daily'],
    ['/how-it-works', 0.5, 'monthly'],
    ['/trust', 0.5, 'monthly'],
    ['/faq', 0.5, 'monthly'],
    ['/about', 0.4, 'monthly'],
    ['/host', 0.6, 'monthly'],
    ['/host/fees', 0.4, 'monthly'],
    ['/support', 0.3, 'monthly'],
    ['/terms', 0.2, 'yearly'],
    ['/privacy', 0.2, 'yearly'],
  ];

  const { rows } = await (await ready()).query<{ id: string; updated_at: Date }>(
    `SELECT id, updated_at FROM property WHERE status = 'PUBLISHED' AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT $1`,
    [MAX_LISTINGS],
  );

  return [
    ...pages.map(([path, priority, freq]) => entry(path, priority, freq)),
    ...CITIES.map((city) => entry(`/search?city=${encodeURIComponent(city)}`, 0.8, 'daily')),
    ...rows.map((r) => entry(`/listing/${r.id}`, 0.7, 'weekly', new Date(r.updated_at))),
  ];
}
