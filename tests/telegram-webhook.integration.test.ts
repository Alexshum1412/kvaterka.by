/**
 * The Telegram webhook (`POST /api/telegram/webhook`), which had no test.
 *
 * It is where a phone number becomes "verified", and it accepted any POST from
 * anyone: two forged requests — a /start with the caller's own verification
 * token, then a "contact" carrying any +375 number — verified that number on
 * the caller's account without Telegram being involved at all. These tests
 * replay exactly that, against the real handler and the real service, and
 * pin down the two checks that close it: the secret Telegram echoes back
 * (registered with setWebhook), and that a shared contact is the sender's own.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { NotificationService } from '@/server/services/notification-service.ts';
import { telegramWebhookSecret } from '@/server/delivery/telegram.ts';
import { uuidv7 } from '@/lib/id.ts';

const runtime = vi.hoisted(() => ({ services: null as unknown }));

vi.mock('@/server/runtime.ts', () => ({
  readyServices: async () => runtime.services,
  env: () => ({ PUBLIC_BASE_URL: 'https://kvaterka.test' }),
}));

const BOT_TOKEN = '123456:test-bot-token';
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;

const { POST } = await import('@/app/api/telegram/webhook/route.ts');

let db: TestDb;
let notifications: NotificationService;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  notifications = new NotificationService(db);
  runtime.services = { notifications };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  // The handler's replies go to api.telegram.org; nothing here may leave.
  vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  userId = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Тэст Тэлеграм')`, [
    userId,
    `${userId}@example.by`,
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function update(body: unknown, secret: string | null = telegramWebhookSecret(BOT_TOKEN)): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret !== null) headers.set('x-telegram-bot-api-secret-token', secret);
  return new Request('http://localhost/api/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function phoneOf(id: string): Promise<{ phone: string | null; verified: boolean }> {
  const { rows } = await db.query<{ phone: string | null; phone_verified_at: Date | null }>(
    `SELECT phone, phone_verified_at FROM app_user WHERE id=$1`,
    [id],
  );
  return { phone: rows[0]!.phone, verified: rows[0]!.phone_verified_at !== null };
}

const CHAT = 424242;

describe('who may speak to the webhook', () => {
  it('refuses the forged two-request phone verification that used to succeed', async () => {
    const token = await notifications.beginPhoneVerification(userId);

    const start = await POST(update({ message: { text: `/start ${token}`, chat: { id: CHAT } } }, null));
    const contact = await POST(
      update({ message: { chat: { id: CHAT }, contact: { phone_number: '+375291112233' } } }, null),
    );

    expect(start.status).toBe(401);
    expect(contact.status).toBe(401);
    expect(await phoneOf(userId)).toEqual({ phone: null, verified: false });
  });

  it('refuses a wrong secret the same way as a missing one', async () => {
    const response = await POST(update({ message: { text: '/help', chat: { id: CHAT } } }, 'guessed'));
    expect(response.status).toBe(401);
  });
});

describe('what counts as proof of a number', () => {
  it('verifies the sender’s own contact, shared through the bot', async () => {
    const token = await notifications.beginPhoneVerification(userId);
    await POST(update({ message: { text: `/start ${token}`, chat: { id: CHAT }, from: { id: CHAT } } }));
    const response = await POST(
      update({
        message: { chat: { id: CHAT }, from: { id: CHAT }, contact: { phone_number: '+375291112233', user_id: CHAT } },
      }),
    );

    expect(response.status).toBe(200);
    expect(await phoneOf(userId)).toEqual({ phone: '+375291112233', verified: true });
  });

  it('refuses somebody else’s contact card forwarded into the chat', async () => {
    const token = await notifications.beginPhoneVerification(userId);
    await POST(update({ message: { text: `/start ${token}`, chat: { id: CHAT }, from: { id: CHAT } } }));
    const response = await POST(
      update({
        message: { chat: { id: CHAT }, from: { id: CHAT }, contact: { phone_number: '+375297654321', user_id: 999 } },
      }),
    );

    expect(response.status).toBe(200);
    expect(await phoneOf(userId)).toEqual({ phone: null, verified: false });
  });
});
