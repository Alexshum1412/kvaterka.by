/**
 * Paid placement — boost tiers, highlight and pin (DEC-072).
 *
 * There was ZERO test coverage for boost purchasing before this file: the
 * flat single-tier product shipped with no integration test at all. This
 * covers the three purchase routes end to end (tier lookup, ownership,
 * publish-state gating, the ledger charge, the audit log) and the two
 * search-ranking behaviours the redesign specifically had to get right —
 * the previously-missing `starts_at <= now()` guard, and pin outranking
 * boost in every sort branch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { SearchService } from '@/server/services/search-service.ts';
import { BOOST_TIERS, HIGHLIGHT_TIERS, PIN_TIERS } from '@/server/domain/promotion-tiers.ts';
import { uuidv7 } from '@/lib/id.ts';

let db: TestDb;
let api: ApiTestClient;
let search: SearchService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  search = new SearchService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

const LISTING = {
  title: 'Уютная квартира в центре города',
  propertyType: 'APARTMENT' as const,
  city: 'Минск',
  latitude: 53.9045,
  longitude: 27.5615,
  maxGuests: 4,
  basePriceMinor: '9000',
  bookingMode: 'INSTANT_AND_REQUEST' as const,
};

/** Same fixture shape as dashboard.integration.test.ts's own `publishedListing`. */
async function publishedListing(landlordToken: string): Promise<string> {
  const id = (await api.post('/listings', LISTING, { token: landlordToken })).body.id as string;
  await api.attachPhoto(id);
  await api.post(`/listings/${id}/submit`, {}, { token: landlordToken });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: moderator.token });
  return id;
}

async function draftListing(landlordToken: string): Promise<string> {
  return (await api.post('/listings', LISTING, { token: landlordToken })).body.id as string;
}

/* ================================================================== *
 * Boost
 * ================================================================== */

describe('POST /listings/:id/boost', () => {
  it('refuses an anonymous caller', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    const res = await api.post(`/listings/${id}/boost`, { tierId: 'SINGLE' });
    expect(res.status).toBe(401);
  });

  it('rejects a tierId outside the fixed menu — the caller cannot invent a tier', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    const res = await api.post(`/listings/${id}/boost`, { tierId: 'FREE_FOREVER' }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('never trusts a client-supplied price — a forged amountMinor/priceMinor field is simply ignored', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    const res = await api.post(
      `/listings/${id}/boost`,
      { tierId: 'SINGLE', priceMinor: '1', amountMinor: '1' },
      { token: landlord.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.priceMinor).toBe(BOOST_TIERS.SINGLE.priceMinor.toString());
  });

  it('refuses to boost a listing that is not published', async () => {
    const landlord = await api.signUp();
    const id = await draftListing(landlord.token);
    const res = await api.post(`/listings/${id}/boost`, { tierId: 'SINGLE' }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('refuses to boost someone else’s listing, with the same 404 as a non-existent one', async () => {
    const owner = await api.signUp();
    const stranger = await api.signUp();
    const id = await publishedListing(owner.token);

    const res = await api.post(`/listings/${id}/boost`, { tierId: 'SINGLE' }, { token: stranger.token });
    expect(res.status).toBe(404);
  });

  it('SINGLE inserts exactly one row for the full price, starting immediately', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/boost`, { tierId: 'SINGLE' }, { token: landlord.token });
    expect(res.status).toBe(200);
    expect(res.body.tierId).toBe('SINGLE');
    expect(res.body.priceMinor).toBe('500');
    expect(res.body.boosts).toHaveLength(1);

    const { rows } = await db.query<{ amount_minor: string; starts_at: Date; ends_at: Date }>(
      `SELECT amount_minor::text, starts_at, ends_at FROM listing_boost WHERE property_id=$1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_minor).toBe('500');
    expect(rows[0]!.starts_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    const durationMs = rows[0]!.ends_at.getTime() - rows[0]!.starts_at.getTime();
    expect(durationMs).toBeCloseTo(24 * 60 * 60 * 1000, -3);
  });

  it('MONTHLY inserts 4 rows a week apart, split evenly, first one active immediately', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/boost`, { tierId: 'MONTHLY' }, { token: landlord.token });
    expect(res.status).toBe(200);
    expect(res.body.priceMinor).toBe('1500');
    expect(res.body.boosts).toHaveLength(4);

    const { rows } = await db.query<{ amount_minor: string; starts_at: Date; ends_at: Date }>(
      `SELECT amount_minor::text, starts_at, ends_at FROM listing_boost WHERE property_id=$1 ORDER BY starts_at`,
      [id],
    );
    expect(rows).toHaveLength(4);
    // 1500 / 4 splits exactly — every row carries the same share, and they
    // sum back to the tier's total price with no rounding leftover.
    for (const row of rows) expect(row.amount_minor).toBe('375');
    const total = rows.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n);
    expect(total).toBe(BOOST_TIERS.MONTHLY.priceMinor);

    // A week apart, in order.
    for (let i = 1; i < rows.length; i += 1) {
      const gapDays = (rows[i]!.starts_at.getTime() - rows[i - 1]!.starts_at.getTime()) / 86_400_000;
      expect(gapDays).toBeCloseTo(7, 1);
    }
    // Only the first row has already started — the other three are dated
    // days and weeks into the future, exactly the case the missing
    // starts_at<=now() search guard had to be fixed for.
    expect(rows[0]!.starts_at.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(rows[3]!.starts_at.getTime()).toBeGreaterThan(Date.now() + 20 * 86_400_000);
  });

  it('TRIPLE_WEEKLY inserts 3 rows a week apart, 12.00 Br split three ways', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/boost`, { tierId: 'TRIPLE_WEEKLY' }, { token: landlord.token });
    expect(res.body.boosts).toHaveLength(3);

    const { rows } = await db.query<{ amount_minor: string }>(
      `SELECT amount_minor::text FROM listing_boost WHERE property_id=$1`,
      [id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n)).toBe(BOOST_TIERS.TRIPLE_WEEKLY.priceMinor);
  });

  it('CONTINUOUS_WEEK inserts one row lasting 7 uninterrupted days at the premium price', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/boost`, { tierId: 'CONTINUOUS_WEEK' }, { token: landlord.token });
    expect(res.body.priceMinor).toBe('4500');
    expect(res.body.boosts).toHaveLength(1);

    const { rows } = await db.query<{ starts_at: Date; ends_at: Date }>(
      `SELECT starts_at, ends_at FROM listing_boost WHERE property_id=$1`,
      [id],
    );
    const durationDays = (rows[0]!.ends_at.getTime() - rows[0]!.starts_at.getTime()) / 86_400_000;
    expect(durationDays).toBeCloseTo(7, 1);
  });

  it('writes exactly one negative BOOST_CHARGED ledger entry for the whole tier price', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    await api.post(`/listings/${id}/boost`, { tierId: 'MONTHLY' }, { token: landlord.token });

    const { rows } = await db.query<{ entry_type: string; amount_minor: string }>(
      `SELECT entry_type, amount_minor::text FROM ledger_entry WHERE landlord_id=$1`,
      [landlord.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry_type).toBe('BOOST_CHARGED');
    expect(rows[0]!.amount_minor).toBe('-1500');
  });
});

/* ================================================================== *
 * Highlight
 * ================================================================== */

describe('POST /listings/:id/highlight', () => {
  it('refuses an anonymous caller', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    expect((await api.post(`/listings/${id}/highlight`, { tierId: 'WEEK' })).status).toBe(401);
  });

  it('rejects an unknown tier', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    const res = await api.post(`/listings/${id}/highlight`, { tierId: 'FOREVER' }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('refuses a listing that is not published', async () => {
    const landlord = await api.signUp();
    const id = await draftListing(landlord.token);
    const res = await api.post(`/listings/${id}/highlight`, { tierId: 'WEEK' }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('refuses someone else’s listing', async () => {
    const owner = await api.signUp();
    const stranger = await api.signUp();
    const id = await publishedListing(owner.token);
    expect((await api.post(`/listings/${id}/highlight`, { tierId: 'WEEK' }, { token: stranger.token })).status).toBe(
      404,
    );
  });

  it('WEEK buys 7 days for 8.00 Br and writes a negative HIGHLIGHT_CHARGED ledger entry', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/highlight`, { tierId: 'WEEK' }, { token: landlord.token });
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ amount_minor: string; starts_at: Date; ends_at: Date }>(
      `SELECT amount_minor::text, starts_at, ends_at FROM listing_highlight WHERE property_id=$1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_minor).toBe(HIGHLIGHT_TIERS.WEEK.priceMinor.toString());
    const durationDays = (rows[0]!.ends_at.getTime() - rows[0]!.starts_at.getTime()) / 86_400_000;
    expect(durationDays).toBeCloseTo(7, 1);

    const ledger = await db.query<{ entry_type: string; amount_minor: string }>(
      `SELECT entry_type, amount_minor::text FROM ledger_entry WHERE landlord_id=$1`,
      [landlord.userId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]!.entry_type).toBe('HIGHLIGHT_CHARGED');
    expect(ledger.rows[0]!.amount_minor).toBe('-800');
  });
});

/* ================================================================== *
 * Pin
 * ================================================================== */

describe('POST /listings/:id/pin', () => {
  it('refuses an anonymous caller', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    expect((await api.post(`/listings/${id}/pin`, { tierId: '1D' })).status).toBe(401);
  });

  it('rejects a tierId outside 1D/2D/7D', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    const res = await api.post(`/listings/${id}/pin`, { tierId: '3D' }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('refuses a listing that is not published', async () => {
    const landlord = await api.signUp();
    const id = await draftListing(landlord.token);
    expect((await api.post(`/listings/${id}/pin`, { tierId: '1D' }, { token: landlord.token })).status).toBe(422);
  });

  it('refuses someone else’s listing', async () => {
    const owner = await api.signUp();
    const stranger = await api.signUp();
    const id = await publishedListing(owner.token);
    expect((await api.post(`/listings/${id}/pin`, { tierId: '1D' }, { token: stranger.token })).status).toBe(404);
  });

  it.each(['1D', '2D', '7D'] as const)('%s buys the matching duration at the matching price', async (tierId) => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    const res = await api.post(`/listings/${id}/pin`, { tierId }, { token: landlord.token });
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ amount_minor: string; starts_at: Date; ends_at: Date }>(
      `SELECT amount_minor::text, starts_at, ends_at FROM listing_pin WHERE property_id=$1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_minor).toBe(PIN_TIERS[tierId].priceMinor.toString());
    const durationDays = (rows[0]!.ends_at.getTime() - rows[0]!.starts_at.getTime()) / 86_400_000;
    expect(durationDays).toBeCloseTo(PIN_TIERS[tierId].durationDays, 1);
  });

  it('writes a negative PIN_CHARGED ledger entry', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    await api.post(`/listings/${id}/pin`, { tierId: '7D' }, { token: landlord.token });

    const { rows } = await db.query<{ entry_type: string; amount_minor: string }>(
      `SELECT entry_type, amount_minor::text FROM ledger_entry WHERE landlord_id=$1`,
      [landlord.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry_type).toBe('PIN_CHARGED');
    expect(rows[0]!.amount_minor).toBe('-5000');
  });
});

/* ================================================================== *
 * Search ranking: starts_at gating, pin above boost, highlight is display-only
 * ================================================================== */

describe('search ranking honours starts_at, and ranks pin above boost', () => {
  it('a future-dated boost row (as a MONTHLY tier\'s later weeks are) does not read as active yet', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);

    // Insert directly rather than through purchase(), to isolate exactly the
    // bug this fix targets: a row whose window has not started yet.
    await db.query(
      `INSERT INTO listing_boost (id, property_id, purchased_by, amount_minor, starts_at, ends_at)
       VALUES ($3, $1, $2, 500, now() + interval '3 days', now() + interval '4 days')`,
      // gen_random_uuid() is core only from PostgreSQL 13; production and the
      // real-postgres job run 10.23, where it does not exist.
      [id, landlord.userId, uuidv7()],
    );

    const result = await search.search({ city: 'Минск' });
    const item = result.items.find((i) => i.id === id);
    expect(item?.isBoosted).toBe(false);
  });

  it('an active boost (starts_at in the past, ends_at in the future) reads as boosted', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    await db.query(
      `INSERT INTO listing_boost (id, property_id, purchased_by, amount_minor, starts_at, ends_at)
       VALUES ($3, $1, $2, 500, now() - interval '1 hour', now() + interval '23 hours')`,
      [id, landlord.userId, uuidv7()],
    );

    const result = await search.search({ city: 'Минск' });
    expect(result.items.find((i) => i.id === id)?.isBoosted).toBe(true);
  });

  it('a MONTHLY purchase reads as boosted immediately (its first row starts now)', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    await api.post(`/listings/${id}/boost`, { tierId: 'MONTHLY' }, { token: landlord.token });

    const result = await search.search({ city: 'Минск' });
    expect(result.items.find((i) => i.id === id)?.isBoosted).toBe(true);
  });

  it('ranks a pinned listing above a merely boosted one, in every sort branch', async () => {
    const boostedOwner = await api.signUp();
    const pinnedOwner = await api.signUp();
    const plainOwner = await api.signUp();

    const boostedId = await publishedListing(boostedOwner.token);
    const pinnedId = await publishedListing(pinnedOwner.token);
    const plainId = await publishedListing(plainOwner.token);

    await api.post(`/listings/${boostedId}/boost`, { tierId: 'SINGLE' }, { token: boostedOwner.token });
    await api.post(`/listings/${pinnedId}/pin`, { tierId: '1D' }, { token: pinnedOwner.token });

    for (const sort of ['RELEVANCE', 'PRICE_ASC', 'PRICE_DESC', 'RATING', 'NEWEST'] as const) {
      const result = await search.search({ city: 'Минск', sort });
      const ids = result.items.map((i) => i.id);
      const pinnedIndex = ids.indexOf(pinnedId);
      const boostedIndex = ids.indexOf(boostedId);
      const plainIndex = ids.indexOf(plainId);
      expect(pinnedIndex).toBeGreaterThanOrEqual(0);
      expect(pinnedIndex).toBeLessThan(boostedIndex);
      expect(boostedIndex).toBeLessThan(plainIndex);
    }

    const pinned = (await search.search({ city: 'Минск' })).items.find((i) => i.id === pinnedId);
    expect(pinned?.isPinned).toBe(true);
    expect(pinned?.isBoosted).toBe(false);
  });

  it('a highlight never changes search order — it only sets isHighlighted', async () => {
    const highlightedOwner = await api.signUp();
    const plainOwner = await api.signUp();
    // Published in this order deliberately: plainId first, highlightedId
    // second, so highlightedId is the genuinely more recent listing. Under
    // NEWEST (published_at DESC) it must rank first for THAT reason alone —
    // if the highlight purchase below were (wrongly) also affecting order,
    // it could only ever reinforce this same result, never contradict it,
    // so asserting highlightedId-before-plainId here would not actually
    // prove the highlight is inert. It is the isHighlighted/isHighlighted
    // assertions just below that carry the real "never changes order" claim
    // — see the search-service.ts orderClause() comment this test mirrors.
    const plainId = await publishedListing(plainOwner.token);
    const highlightedId = await publishedListing(highlightedOwner.token);

    await api.post(`/listings/${highlightedId}/highlight`, { tierId: 'WEEK' }, { token: highlightedOwner.token });

    const result = await search.search({ city: 'Минск', sort: 'NEWEST' });
    const highlighted = result.items.find((i) => i.id === highlightedId);
    const plain = result.items.find((i) => i.id === plainId);
    expect(highlighted?.isHighlighted).toBe(true);
    expect(plain?.isHighlighted).toBe(false);
    // NEWEST with no boost/pin on either listing: ordering is purely
    // published_at DESC — highlightedId ranks first because it really is
    // the newer listing (see above), not because of the highlight.
    const ids = result.items.map((i) => i.id);
    expect(ids.indexOf(highlightedId)).toBeLessThan(ids.indexOf(plainId));
  });
});
