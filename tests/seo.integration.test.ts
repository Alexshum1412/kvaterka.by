/**
 * robots.txt and sitemap.xml — what search engines are told exists (DEC-086).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { uuidv7 } from '@/lib/id.ts';

const runtime = vi.hoisted(() => ({ db: null as unknown, indexable: true }));
vi.mock('@/server/runtime.ts', () => ({
  env: () => ({ PUBLIC_BASE_URL: 'https://kvaterka.by', SITE_INDEXABLE: runtime.indexable }),
  ready: async () => runtime.db,
}));

const { default: sitemap } = await import('@/app/sitemap.ts');
const { default: robots } = await import('@/app/robots.ts');

let db: TestDb;
let published: string;
let draft: string;

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
  const owner = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Сэо')`, [owner, `${owner}@example.by`]);
  published = uuidv7();
  draft = uuidv7();
  for (const [id, status] of [
    [published, 'PUBLISHED'],
    [draft, 'DRAFT'],
  ] as const) {
    await db.query(
      `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
          public_latitude, public_longitude, base_price_minor, price_unit, min_nights, max_nights,
          max_guests, booking_mode, status, published_at)
       VALUES ($1,$2,'Светлая кватэра ў цэнтры','Минск','APARTMENT',53.9,27.5,53.9,27.5,8000,'NIGHT',1,365,4,
          'INSTANT_AND_REQUEST',$3, CASE WHEN $3 = 'PUBLISHED' THEN now() END)`,
      [id, owner, status],
    );
  }
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
