/**
 * The inbox and the preferences that describe it.
 *
 * Both surfaces existed as API and neither had a screen, which is how the
 * defect below survived: `getPreferences` reported IN_APP as OFF by default
 * for every non-mandatory category, while `channelAllowed` — the function that
 * actually decides — treated it as ON. Nothing delivered wrongly; the
 * description of what would be delivered was wrong. That is invisible until
 * somebody renders it, and a settings screen whose only job is to describe the
 * system is the worst place for it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { NotificationService, NOTIFICATION_CATEGORIES, MANDATORY_IN_APP } from '@/server/services/notification-service.ts';

let db: TestDb;
let api: ApiTestClient;
let notifications: NotificationService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  notifications = new NotificationService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

describe('what the settings screen says matches what the system does', () => {
  it('reports every default exactly as the delivery path applies it', async () => {
    const user = await api.signUp();
    const preferences = await notifications.getPreferences(user.userId);

    for (const category of NOTIFICATION_CATEGORIES) {
      // The observable proof: enqueue on each channel with no preference rows
      // at all, and see which ones the service actually queues.
      const queued = await notifications.enqueue({
        userId: user.userId,
        category,
        dedupeKey: `defaults:${category}`,
      });

      expect(preferences[category]!['IN_APP']).toBe(queued.includes('IN_APP'));
      expect(preferences[category]!['EMAIL']).toBe(queued.includes('EMAIL'));
      expect(preferences[category]!['TELEGRAM']).toBe(queued.includes('TELEGRAM'));
    }
  });

  it('never offers Telegram as on by default, since consent has not been given', async () => {
    const user = await api.signUp();
    const preferences = await notifications.getPreferences(user.userId);

    for (const category of NOTIFICATION_CATEGORIES) {
      expect(preferences[category]!['TELEGRAM']).toBe(false);
    }
  });

  it('refuses to silence in-app security, debt and moderation notices', async () => {
    const user = await api.signUp();

    for (const category of MANDATORY_IN_APP) {
      const response = await api.put(
        '/notifications/preferences',
        { category, channel: 'IN_APP', enabled: false },
        { token: user.token },
      );
      expect(response.status).toBe(422);

      // And the refusal is real, not cosmetic: the notification still queues.
      const queued = await notifications.enqueue({
        userId: user.userId,
        category,
        dedupeKey: `mandatory:${category}`,
        channels: ['IN_APP'],
      });
      expect(queued).toContain('IN_APP');
    }
  });

  it('lets a product notification be switched off, and then stops queueing it', async () => {
    const user = await api.signUp();

    const response = await api.put(
      '/notifications/preferences',
      { category: 'REVIEW_REQUEST', channel: 'IN_APP', enabled: false },
      { token: user.token },
    );
    expect(response.status).toBe(200);

    const queued = await notifications.enqueue({
      userId: user.userId,
      category: 'REVIEW_REQUEST',
      dedupeKey: 'off:review',
      channels: ['IN_APP'],
    });
    expect(queued).toEqual([]);
  });
});

describe('the unread count the header renders', () => {
  it('counts unread in-app notifications and nothing else', async () => {
    const user = await api.signUp();
    const other = await api.signUp();

    await notifications.enqueue({ userId: user.userId, category: 'MESSAGE', dedupeKey: 'a' });
    await notifications.enqueue({ userId: user.userId, category: 'BOOKING_REQUEST', dedupeKey: 'b' });
    // Somebody else's notification must never reach this number.
    await notifications.enqueue({ userId: other.userId, category: 'MESSAGE', dedupeKey: 'c' });

    expect(await notifications.unreadCount(user.userId)).toBe(2);
    expect(await notifications.unreadCount(other.userId)).toBe(1);
  });

  it('excludes a notification the person chose not to receive', async () => {
    const user = await api.signUp();
    await api.put(
      '/notifications/preferences',
      { category: 'REVIEW_REQUEST', channel: 'IN_APP', enabled: false },
      { token: user.token },
    );

    await notifications.enqueue({
      userId: user.userId,
      category: 'REVIEW_REQUEST',
      dedupeKey: 'suppressed',
      channels: ['IN_APP'],
    });

    // The row exists, as SUPPRESSED. A withheld notification is not something
    // the person has failed to read, so it must not sit on the bell for ever.
    expect(await notifications.unreadCount(user.userId)).toBe(0);
  });

  it('falls to zero once everything is read, and the inbox agrees', async () => {
    const user = await api.signUp();
    await notifications.enqueue({ userId: user.userId, category: 'MESSAGE', dedupeKey: 'x' });
    await notifications.enqueue({ userId: user.userId, category: 'CHECK_IN', dedupeKey: 'y' });

    const read = await api.post('/notifications/read', {}, { token: user.token });
    expect(read.status).toBe(200);
    expect(read.body.read).toBe(2);

    expect(await notifications.unreadCount(user.userId)).toBe(0);

    const inbox = await api.get('/notifications', { token: user.token });
    expect(inbox.status).toBe(200);
    expect(inbox.body).toHaveLength(2);
    expect(inbox.body.every((n: { readAt: string | null }) => n.readAt !== null)).toBe(true);
  });

  it('marks one notification without touching the rest', async () => {
    const user = await api.signUp();
    await notifications.enqueue({ userId: user.userId, category: 'MESSAGE', dedupeKey: 'one' });
    await notifications.enqueue({ userId: user.userId, category: 'CHECK_IN', dedupeKey: 'two' });

    const inbox = await api.get('/notifications', { token: user.token });
    const first = inbox.body[0].id;

    await api.post('/notifications/read', { id: first }, { token: user.token });
    expect(await notifications.unreadCount(user.userId)).toBe(1);
  });

  it('cannot be used to mark somebody else’s notification read', async () => {
    const owner = await api.signUp();
    const stranger = await api.signUp();
    await notifications.enqueue({ userId: owner.userId, category: 'MESSAGE', dedupeKey: 'mine' });

    const inbox = await api.get('/notifications', { token: owner.token });
    const id = inbox.body[0].id;

    const response = await api.post('/notifications/read', { id }, { token: stranger.token });

    // The route is scoped by user id in SQL, so this is a no-op rather than an
    // error — and the owner's count is untouched, which is what matters.
    expect(response.status).toBe(200);
    expect(response.body.read).toBe(0);
    expect(await notifications.unreadCount(owner.userId)).toBe(1);
  });
});

describe('the inbox itself', () => {
  it('never returns another user’s notifications', async () => {
    const owner = await api.signUp();
    const stranger = await api.signUp();
    await notifications.enqueue({ userId: owner.userId, category: 'DEBT', dedupeKey: 'debt' });

    const response = await api.get('/notifications', { token: stranger.token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('requires a session', async () => {
    const response = await api.get('/notifications');
    expect(response.status).toBe(401);
  });

  it('returns newest first, so the thing that just happened is at the top', async () => {
    const user = await api.signUp();
    await notifications.enqueue({ userId: user.userId, category: 'MESSAGE', dedupeKey: 'first' });
    await notifications.enqueue({ userId: user.userId, category: 'CHECK_OUT', dedupeKey: 'second' });

    const inbox = await api.get('/notifications', { token: user.token });
    expect(inbox.body[0].category).toBe('CHECK_OUT');
  });
});
