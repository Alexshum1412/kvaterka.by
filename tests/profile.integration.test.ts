/**
 * `GET /me/profile`.
 *
 * The route has always queried and returned email, phone, verification
 * state, verification level, status, member-since and (since 0022) an
 * avatar key — but until the account page grew a read-only info section
 * nothing checked that any of it actually reached the response. This is
 * the assertion that keeps that shape honest: it is what
 * `src/ui/profile-settings.tsx` now reads field-by-field to render.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});

describe('GET /me/profile', () => {
  it('surfaces email, phone, verification state, level, member-since and avatar key', async () => {
    const user = await api.signUp();

    const res = await api.get('/me/profile', { token: user.token });
    expect(res.status).toBe(200);

    expect(res.body.email).toBe(user.email);
    expect(res.body.phone).toBeNull();
    // Confirming the registration code IS proving control of the inbox — see
    // `confirmRegistration`'s INSERT, which sets email_verified_at at the
    // same moment the account is created. Phone was never supplied here, so
    // it stays unset and therefore unverified.
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.phoneVerified).toBe(false);
    expect(res.body.verificationLevel).toBe(0);
    expect(res.body.avatarStorageKey).toBeNull();
    // A real HTTP round trip serialises this to an ISO string (which is what
    // `profile-settings.tsx` feeds straight into `new Date(...)`); the
    // in-process test client skips that JSON pass and hands back whatever
    // the driver returned, so this only pins "present and a real instant",
    // not the wire representation.
    expect(res.body.memberSince).toBeTruthy();
    expect(Number.isNaN(new Date(res.body.memberSince).getTime())).toBe(false);
    // Unchanged by this task, but still part of the same response the
    // profile screen reads — a regression here would silently blank the
    // trust section rather than fail loudly.
    expect(res.body.trust).toBeDefined();
  });

  it('reports a linked avatar once one is uploaded', async () => {
    const user = await api.signUp();
    await db.query(`UPDATE app_user SET avatar_storage_key=$1 WHERE id=$2`, [
      `avatars/${user.userId}/pic.jpg`,
      user.userId,
    ]);

    const res = await api.get('/me/profile', { token: user.token });
    expect(res.body.avatarStorageKey).toBe(`avatars/${user.userId}/pic.jpg`);
  });

  it('refuses an anonymous caller', async () => {
    const res = await api.get('/me/profile');
    expect(res.status).toBe(401);
  });
});
