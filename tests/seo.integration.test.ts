/**
 * robots.txt, sitemap.xml and the city landing pages' <head> — what search
 * engines are told exists (DEC-086).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { uuidv7 } from '@/lib/id.ts';

const runtime = vi.hoisted(() => ({ db: null as unknown, indexable: true }));
vi.mock('@/server/runtime.ts', () => ({
  env: () => ({ PUBLIC_BASE_URL: 'https://kvaterka.by', SITE_INDEXABLE: runtime.indexable }),
  ready: async () => runtime.db,
}));

/* The search page pulls in the whole UI tree; only its generateMetadata runs
   here. next-intl/navigation cannot be loaded by vitest's node runner (it
   imports `next/navigation` without an extension), so getPathname is a
   stand-in over the real routing config — same output as the real one for
   these hrefs (checked: `/be/search?city=%D0%9C…`, query kept). */
vi.mock('@/i18n/navigation.ts', async () => {
  const { routing } = await import('@/i18n/routing.ts');
  return {
    Link: () => null,
    getPathname: ({ locale, href }: { locale: string; href: string }) =>
      `${locale === routing.defaultLocale ? '' : `/${locale}`}${href === '/' && locale !== routing.defaultLocale ? '' : href}`,
  };
});
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ru',
  getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('@/server/session.ts', () => ({ currentUser: async () => null }));
vi.mock('@/ui/search-form.tsx', () => ({}));
vi.mock('@/ui/search-filters.tsx', () => ({}));
vi.mock('@/ui/listing-card.tsx', () => ({}));
vi.mock('@/ui/search-mobile-view.tsx', () => ({}));
vi.mock('@/ui/primitives.tsx', () => ({}));
vi.mock('@/ui/icons.tsx', () => ({}));

const { default: sitemap } = await import('@/app/sitemap.ts');
const { generateMetadata: searchMetadata } = await import('@/app/[locale]/search/page.tsx');
const { default: robots } = await import('@/app/robots.ts');

let db: TestDb;
let owner: string;
let published: string;
let draft: string;

/** One listing of the seeded owner, in `city`, with the given lifecycle status. */
async function addListing(city: string, status: 'PUBLISHED' | 'DRAFT'): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
        public_latitude, public_longitude, base_price_minor, price_unit, min_nights, max_nights,
        max_guests, booking_mode, status, published_at)
     VALUES ($1,$2,'Светлая кватэра ў цэнтры',$4,'APARTMENT',53.9,27.5,53.9,27.5,8000,'NIGHT',1,365,4,
        'INSTANT_AND_REQUEST',$3, CASE WHEN $3 = 'PUBLISHED' THEN now() END)`,
    [id, owner, status, city],
  );
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  runtime.db = db;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  runtime.indexable = true;
  owner = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Сэо')`, [
    owner,
    `${owner}@example.by`,
  ]);
  published = await addListing('Минск', 'PUBLISHED');
  draft = await addListing('Минск', 'DRAFT');
});

describe('sitemap.xml', () => {
  it('lists published listings, and only published ones', async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain(`https://kvaterka.by/listing/${published}`);
    expect(urls.some((u) => u.includes(draft))).toBe(false);
  });

  it('gives every page its Belarusian and English alternates, the home page included', async () => {
    const entries = await sitemap();
    const faq = entries.find((e) => e.url === 'https://kvaterka.by/faq')!;
    expect(faq.alternates?.languages).toEqual({
      ru: 'https://kvaterka.by/faq',
      be: 'https://kvaterka.by/be/faq',
      en: 'https://kvaterka.by/en/faq',
    });
    const home = entries.find((e) => e.url === 'https://kvaterka.by/')!;
    expect(home.alternates?.languages).toMatchObject({ be: 'https://kvaterka.by/be' });
  });

  it('is empty on a deployment that is not meant to be found', async () => {
    runtime.indexable = false;
    expect(await sitemap()).toEqual([]);
  });

  it('lists a city page only once the city has a published listing', async () => {
    const cityUrl = (city: string) => `https://kvaterka.by/search?city=${encodeURIComponent(city)}`;
    let urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain(cityUrl('Минск'));
    expect(urls).not.toContain(cityUrl('Гродно'));

    await addListing('гродно', 'PUBLISHED'); // /search matches the city case-insensitively, so must the sitemap
    urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain(cityUrl('Гродно'));
  });

  it('does not list a city whose only listing is a draft, or that is not one of the six', async () => {
    await addListing('Брест', 'DRAFT');
    await addListing('Пинск', 'PUBLISHED');
    const urls = (await sitemap()).map((e) => decodeURIComponent(e.url));
    expect(urls).not.toContain('https://kvaterka.by/search?city=Брест');
    expect(urls.some((u) => u.includes('Пинск'))).toBe(false);
  });
});

describe('city landing pages', () => {
  const CITIES = ['Минск', 'Гродно', 'Брест', 'Витебск', 'Гомель', 'Могилёв'];
  const LOCALES = ['ru', 'be', 'en'] as const;
  const meta = (locale: string, search: Record<string, string | string[] | undefined>) =>
    searchMetadata({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(search) });
  const languagesFor = (city: string) => {
    const q = `/search?city=${encodeURIComponent(city)}`;
    return { ru: q, be: `/be${q}`, en: `/en${q}`, 'x-default': q };
  };

  it('is its own canonical in every locale, with the city query kept', async () => {
    for (const locale of LOCALES) {
      const { alternates } = await meta(locale, { city: 'Минск' });
      expect(alternates?.canonical).toBe(languagesFor('Минск')[locale]);
    }
  });

  it('advertises the full reciprocal hreflang set, city query and x-default included, from each locale', async () => {
    for (const city of CITIES) {
      for (const locale of LOCALES) {
        const { alternates } = await meta(locale, { city });
        expect(alternates?.languages).toEqual(languagesFor(city));
        // Reciprocal: the page lists itself among the alternates.
        expect((alternates?.languages as Record<string, string>)[locale]).toBe(alternates?.canonical);
      }
    }
  });

  it('says the same as the sitemap for every city it lists', async () => {
    for (const city of CITIES) if (city !== 'Минск') await addListing(city, 'PUBLISHED');
    const entries = await sitemap();
    for (const city of CITIES) {
      const entry = entries.find(
        (e) => e.url === `https://kvaterka.by/search?city=${encodeURIComponent(city)}`,
      )!;
      const { alternates } = await meta('ru', { city });
      const pageLanguages = Object.entries((alternates?.languages ?? {}) as Record<string, string>)
        .filter(([l]) => l !== 'x-default')
        .map(([l, path]) => [l, `https://kvaterka.by${path}`]);
      expect(entry.alternates?.languages).toEqual(Object.fromEntries(pageLanguages));
    }
  });

  it('ignores empty query values, as the page itself does', async () => {
    const { alternates } = await meta('be', { city: 'Гродно', district: '', guests: undefined });
    expect(alternates?.languages).toEqual(languagesFor('Гродно'));
  });

  it('leaves every other search URL alone: canonical only, no hreflang of its own', async () => {
    const plain = await meta('en', {});
    expect(plain.alternates).toEqual({ canonical: '/en/search' });
    const filtered = await meta('be', { guests: '2', sort: 'PRICE_ASC' });
    expect(filtered.alternates).toEqual({ canonical: '/be/search' });
    const emptyCity = await meta('ru', { city: '' });
    expect(emptyCity.alternates).toEqual({ canonical: '/search' });
    const repeatedCity = await meta('ru', { city: ['Минск', 'Гродно'] });
    expect(repeatedCity.alternates).toEqual({ canonical: '/search' });
  });

  it('a city with any filter is a result list, not a landing page: canonical is the city page, no hreflang', async () => {
    for (const extra of [
      { guests: '2' },
      { from: '2026-10-01' },
      { sort: 'PRICE_ASC' },
      { amenities: ['wifi', 'tv'] },
    ]) {
      const { alternates } = await meta('be', { city: 'Минск', ...extra });
      expect(alternates).toEqual({ canonical: languagesFor('Минск').be });
    }
  });
});

describe('robots.txt', () => {
  it('keeps crawlers out of private pages in every locale, not only Russian', () => {
    const rules = robots().rules as { disallow: string[] }[];
    const disallow = rules[0]!.disallow;
    for (const path of ['/dashboard/', '/be/dashboard/', '/en/dashboard/', '/en/trips', '/be/bookings/']) {
      expect(disallow).toContain(path);
    }
  });
});
