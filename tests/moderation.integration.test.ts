/**
 * Listing moderation, end to end.
 *
 * The properties worth defending here are not "can a moderator click
 * approve". They are: nothing incomplete or undecided ever becomes
 * publicly reachable, a moderator cannot see identity documents, the
 * decision history cannot be rewritten, and a rejected landlord is told
 * something they can act on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';

let db: TestDb;
let api: ApiTestClient;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
  await db.execScript(`
    INSERT INTO amenity (code, category, name_ru, name_be, name_en) VALUES
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi')
    ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true),
      ('verification.identity_documents', false, 'test', true)
    ON CONFLICT DO NOTHING;
  `);
});

const COMPLETE = {
  title: 'Светлая двушка у метро Немига',
  city: 'Минск',
  district: 'Центральный',
  latitude: 53.9045,
  longitude: 27.5615,
  rooms: 2,
  areaSqm: 54,
  floor: 4,
  totalFloors: 9,
  maxGuests: 4,
  basePriceMinor: '9000',
  minNights: 2,
  maxNights: 90,
  amenities: ['WIFI'],
  // Deliberately unmistakable, so a leak check on the serialised payload
  // cannot pass by accident: these strings occur nowhere else — not in a
  // uuid, a coordinate, a timestamp or the title.
  street: 'Скрытая-XYZ',
  houseNumber: 'ДОМ-QQQ',
  apartmentNumber: 'КВ-СЕКРЕТ',
};

async function moderator() {
  const account = await api.signUp();
  await api.grantRole(account.userId, 'MODERATOR');
  return account;
}

/** A landlord listing that has been submitted and is awaiting a decision. */
async function pendingListing() {
  const landlord = await api.signUp();
  const created = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
  const id = created.body.id as string;
  await api.patch(`/listings/${id}`, COMPLETE, { token: landlord.token });
  await api.attachPhoto(id);
  const submitted = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
  expect(submitted.status).toBe(200);
  return { landlord, id };
}

/* ================================================================== */

describe('queue authorization', () => {
  it('refuses anonymous callers', async () => {
    const res = await api.get('/admin/moderation/listings');
    expect(res.status).toBe(401);
  });

  it('refuses an ordinary user', async () => {
    const user = await api.signUp();
    const res = await api.get('/admin/moderation/listings', { token: user.token });
    expect(res.status).toBe(403);
  });

  it('refuses a landlord, even for their own listing', async () => {
    const { landlord, id } = await pendingListing();
    const res = await api.get(`/admin/moderation/listings/${id}`, { token: landlord.token });
    expect(res.status).toBe(403);
  });

  it('admits a moderator', async () => {
    await pendingListing();
    const mod = await moderator();
    const res = await api.get('/admin/moderation/listings', { token: mod.token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.counts.PENDING_MODERATION).toBe(1);
  });

  it('answers 404 for a malformed listing id rather than failing', async () => {
    const mod = await moderator();
    const res = await api.get('/admin/moderation/listings/not-a-uuid', { token: mod.token });
    expect(res.status).toBe(404);
  });

  it('answers 404 for a well-formed id that does not exist', async () => {
    const mod = await moderator();
    const res = await api.get(`/admin/moderation/listings/${randomUUID()}`, { token: mod.token });
    expect(res.status).toBe(404);
  });
});

describe('the queue itself', () => {
  it('never contains another landlord’s private draft', async () => {
    const landlord = await api.signUp();
    await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    const mod = await moderator();

    const pending = await api.get('/admin/moderation/listings', { token: mod.token });
    expect(pending.body.items).toHaveLength(0);

    // Not even under the "everything" tab.
    const all = await api.get('/admin/moderation/listings?status=ALL', { token: mod.token });
    expect(all.body.items).toHaveLength(0);
  });

  it('orders by how long the landlord has waited', async () => {
    const first = await pendingListing();
    const second = await pendingListing();
    const mod = await moderator();

    const res = await api.get('/admin/moderation/listings?sort=WAITING_LONGEST', { token: mod.token });
    expect(res.body.items.map((i: any) => i.id)).toEqual([first.id, second.id]);

    const reversed = await api.get('/admin/moderation/listings?sort=WAITING_SHORTEST', { token: mod.token });
    expect(reversed.body.items.map((i: any) => i.id)).toEqual([second.id, first.id]);
  });

  it('filters by city and searches title and owner', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    expect((await api.get('/admin/moderation/listings?city=Минск', { token: mod.token })).body.items).toHaveLength(1);
    expect((await api.get('/admin/moderation/listings?city=Брест', { token: mod.token })).body.items).toHaveLength(0);
    expect((await api.get('/admin/moderation/listings?q=Немига', { token: mod.token })).body.items).toHaveLength(1);
    expect((await api.get('/admin/moderation/listings?q=нетакого', { token: mod.token })).body.items).toHaveLength(0);

    const paged = await api.get('/admin/moderation/listings?limit=1&offset=1', { token: mod.token });
    expect(paged.body.items).toHaveLength(0);
    expect(paged.body.offset).toBe(1);
    expect(id).toBeTruthy();
  });
});

describe('what a moderator may and may not see', () => {
  it('shows the listing, the owner’s trust facts and the photos', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const res = await api.get(`/admin/moderation/listings/${id}`, { token: mod.token });
    expect(res.status).toBe(200);
    expect(res.body.listing.title).toBe(COMPLETE.title);
    expect(res.body.listing.photos).toHaveLength(1);
    expect(res.body.listing.amenities[0].code).toBe('WIFI');
    expect(res.body.listing.owner.verificationLevel).toBeDefined();
    expect(res.body.listing.owner.completedRentals).toBe(0);
    expect(res.body.listing.duration).toEqual({ minNights: 2, maxNights: 90 });
  });

  it('does NOT include the exact address', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const res = await api.get(`/admin/moderation/listings/${id}`, { token: mod.token });
    const serialised = JSON.stringify(res.body);
    // The landlord entered these; a moderator has no entitlement to them
    // (DEC-020 gives the exact address one checked accessor).
    expect(serialised).not.toContain('houseNumber');
    expect(serialised).not.toContain('apartmentNumber');
    expect(serialised).not.toContain('street');
    expect(serialised).not.toContain('Скрытая-XYZ');
    expect(serialised).not.toContain('ДОМ-QQQ');
    expect(serialised).not.toContain('КВ-СЕКРЕТ');
    expect(res.body.listing.location.precision).toBe('APPROXIMATE');
    // And the coordinates shown are the blurred ones.
    expect(res.body.listing.location.latitude).not.toBe(COMPLETE.latitude);
  });

  it('does NOT let a moderator reach identity documents', async () => {
    const mod = await moderator();
    const res = await api.get(`/admin/verification/documents/${randomUUID()}`, { token: mod.token });
    // 403 from the permission gate, never 404-from-lookup: the request is
    // refused before anything is read.
    expect(res.status).toBe(403);
  });

  it('does NOT let an admin reach identity documents either', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const res = await api.get(`/admin/verification/documents/${randomUUID()}`, { token: admin.token });
    expect(res.status).toBe(403);
  });
});

describe('approval', () => {
  it('publishes the listing and makes it publicly reachable', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const decision = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PUBLISHED' },
      { token: mod.token },
    );
    expect(decision.status).toBe(200);

    const publicView = await api.get(`/listings/${id}`);
    expect(publicView.status).toBe(200);
  });

  it('makes it appear in public search', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });

    const search = await api.get('/search?city=Минск');
    expect(search.body.items.map((i: any) => i.id)).toContain(id);
  });

  it('records the moderator, the timestamp and the previous status', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });

    const res = await api.get(`/admin/moderation/listings/${id}`, { token: mod.token });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].decision).toBe('PUBLISHED');
    expect(res.body.history[0].fromStatus).toBe('PENDING_MODERATION');
    expect(res.body.history[0].createdAt).toBeTruthy();
    expect(res.body.listing.publishedAt).toBeTruthy();
  });

  it('writes an audit record', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });

    const { rows } = await db.query<{ action: string; actor_user_id: string }>(
      `SELECT action, actor_user_id FROM audit_log WHERE target_id = $1 AND action = 'listing.moderate'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(mod.userId);
  });

  it('refuses to approve the same listing twice', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });

    const again = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PUBLISHED' },
      { token: mod.token },
    );
    // PUBLISHED → PUBLISHED is not a legal moderator transition, so a
    // double click cannot republish or re-stamp published_at.
    expect(again.status).toBe(409);
    expect(
      (await api.get(`/admin/moderation/listings/${id}`, { token: mod.token })).body.history,
    ).toHaveLength(1);
  });
});

describe('rejection', () => {
  it('requires a reason of some kind', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED' },
      { token: mod.token },
    );
    expect(res.status).toBe(422);
  });

  it('accepts structured reason codes and tells the landlord', async () => {
    const { landlord, id } = await pendingListing();
    const mod = await moderator();

    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['INSUFFICIENT_PHOTOS', 'INCORRECT_PRICE'] },
      { token: mod.token },
    );
    expect(res.status).toBe(200);

    // The landlord sees a sentence, not a code.
    const own = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(own.body.status).toBe('REJECTED');
    expect(own.body.rejectionReason).toContain('фотографий');

    const history = (await api.get(`/admin/moderation/listings/${id}`, { token: mod.token })).body.history;
    expect(history[0].reasonCodes).toEqual(['INSUFFICIENT_PHOTOS', 'INCORRECT_PRICE']);
  });

  it('keeps a free-text-only rejection working, recorded as OTHER', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reason: 'Фотографии не соответствуют описанию' },
      { token: mod.token },
    );
    expect(res.status).toBe(200);

    const history = (await api.get(`/admin/moderation/listings/${id}`, { token: mod.token })).body.history;
    expect(history[0].reasonCodes).toEqual(['OTHER']);
    expect(history[0].comment).toBe('Фотографии не соответствуют описанию');
  });

  it('rejects an unknown reason code', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();

    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['MADE_UP_REASON'] },
      { token: mod.token },
    );
    expect(res.status).toBe(422);
  });

  it('does not make a rejected listing public', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['PROHIBITED_CONTENT'] },
      { token: mod.token },
    );

    expect((await api.get(`/listings/${id}`)).status).toBe(404);
    const search = await api.get('/search?city=Минск');
    expect(search.body.items.map((i: any) => i.id)).not.toContain(id);
  });
});

describe('resubmission', () => {
  it('lets the landlord fix and resubmit, and keeps the earlier decision', async () => {
    const { landlord, id } = await pendingListing();
    const mod = await moderator();

    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['INSUFFICIENT_DESCRIPTION'], reason: 'Добавьте описание' },
      { token: mod.token },
    );

    // The landlord edits — no need to recreate anything.
    await api.patch(`/listings/${id}`, { description: 'Тихая квартира рядом с парком и метро.' }, {
      token: landlord.token,
    });
    const resubmitted = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(resubmitted.status).toBe(200);

    const own = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(own.body.status).toBe('PENDING_MODERATION');
    // The stale rejection notice is cleared once it has been acted on.
    expect(own.body.rejectionReason).toBeNull();

    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });

    const history = (await api.get(`/admin/moderation/listings/${id}`, { token: mod.token })).body.history;
    expect(history).toHaveLength(2);
    expect(history[0].decision).toBe('PUBLISHED');
    expect(history[1].decision).toBe('REJECTED');
    expect(history[1].reasonCodes).toEqual(['INSUFFICIENT_DESCRIPTION']);
    expect(history[1].comment).toBe('Добавьте описание');
  });

  it('cannot have its history rewritten', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['OTHER'], reason: 'Первое решение' },
      { token: mod.token },
    );

    await expect(
      db.query(`UPDATE listing_moderation_review SET comment = 'подделка' WHERE property_id = $1`, [id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM listing_moderation_review WHERE property_id = $1`, [id]),
    ).rejects.toThrow();
  });

  it('lets the history go when the listing itself is deleted', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reasonCodes: ['OTHER'], reason: 'Решение' },
      { token: mod.token },
    );

    // Editing history is forbidden; a listing taking its own history with
    // it is the data-minimising outcome, not an edit (migration 0010).
    await expect(db.query(`DELETE FROM property WHERE id = $1`, [id])).resolves.toBeDefined();

    const { rows } = await db.query(
      `SELECT count(*)::text AS c FROM listing_moderation_review WHERE property_id = $1`,
      [id],
    );
    expect((rows[0] as { c: string }).c).toBe('0');

    // The audit trail is not cascaded and survives.
    const audit = await db.query(
      `SELECT count(*)::text AS c FROM audit_log WHERE target_id = $1 AND action = 'listing.moderate'`,
      [id],
    );
    expect((audit.rows[0] as { c: string }).c).toBe('1');
  });
});

describe('publication safety', () => {
  it('cannot publish an incomplete listing, even straight through the service', async () => {
    const landlord = await api.signUp();
    const created = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    const id = created.body.id as string;

    // Force it into the queue past the service guard, as a bug might.
    await expect(
      db.query(`UPDATE property SET status='PENDING_MODERATION' WHERE id=$1`, [id]),
    ).rejects.toThrow();

    // And it is still not public.
    expect((await api.get(`/listings/${id}`)).status).toBe(404);
  });

  it('keeps a pending listing out of public search', async () => {
    const { id } = await pendingListing();
    const search = await api.get('/search?city=Минск');
    expect(search.body.items.map((i: any) => i.id)).not.toContain(id);
  });

  it('lets the owner preview their own pending listing but nobody else', async () => {
    const { landlord, id } = await pendingListing();
    const stranger = await api.signUp();

    expect((await api.get(`/listings/${id}`, { token: landlord.token })).status).toBe(200);
    expect((await api.get(`/listings/${id}`, { token: stranger.token })).status).toBe(404);
    expect((await api.get(`/listings/${id}`)).status).toBe(404);
  });

  it('removes a paused listing from search without deleting it', async () => {
    const { id } = await pendingListing();
    const mod = await moderator();
    await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: mod.token });
    expect((await api.get('/search?city=Минск')).body.items.map((i: any) => i.id)).toContain(id);

    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PAUSED', reasonCodes: ['SUSPICIOUS_INFORMATION'] },
      { token: mod.token },
    );
    expect((await api.get('/search?city=Минск')).body.items.map((i: any) => i.id)).not.toContain(id);
  });

  it('does not let a landlord publish their own listing', async () => {
    const { landlord, id } = await pendingListing();
    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PUBLISHED' },
      { token: landlord.token },
    );
    expect(res.status).toBe(403);
    expect((await api.get(`/listings/${id}`)).status).toBe(404);
  });

  it('does not let one landlord submit another’s listing', async () => {
    const landlord = await api.signUp();
    const other = await api.signUp();
    const created = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    const id = created.body.id as string;

    const res = await api.post(`/listings/${id}/submit`, {}, { token: other.token });
    expect([403, 404]).toContain(res.status);
  });
});
