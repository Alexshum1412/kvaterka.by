/**
 * Notification delivery and booking expiry.
 *
 * The delivery half is adversarial by necessity: the dangerous outcomes are
 * "told somebody twice", "recorded a delivery that never happened", and
 * "hammered a dead provider until it stayed dead". None of those is visible in
 * a happy-path test, so most of what follows is about the claim being
 * exclusive, SENT being unreachable except through a real DELIVERED, and the
 * retry ladder actually escalating.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { NotificationService } from '@/server/services/notification-service.ts';
import { RetentionService } from '@/server/services/retention-service.ts';
import { DeliveryService } from '@/server/services/delivery-service.ts';
import { BookingService } from '@/server/services/booking-service.ts';
import {
  delivered,
  inAppProvider,
  permanent,
  transient,
  unconfiguredProvider,
  type DeliveryMessage,
  type DeliveryProvider,
  type ProviderSet,
} from '@/server/delivery/provider.ts';
import { uuidv7 } from '@/lib/id.ts';

let db: TestDb;
let api: ApiTestClient;
let notifications: NotificationService;
let retention: RetentionService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  notifications = new NotificationService(db);
  retention = new RetentionService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

/* ------------------------------------------------------------------ *
 * Provider doubles
 * ------------------------------------------------------------------ */

function spyProvider(
  channel: 'EMAIL' | 'TELEGRAM' | 'IN_APP',
  behaviour: (m: DeliveryMessage) => ReturnType<DeliveryProvider['send']>,
): DeliveryProvider & { sent: DeliveryMessage[] } {
  const sent: DeliveryMessage[] = [];
  return {
    sent,
    channel,
    configured: true,
    describe: () => `${channel}: test double`,
    async send(message) {
      sent.push(message);
      return behaviour(message);
    },
  };
}

function providerSet(email: DeliveryProvider): ProviderSet {
  const byChannel = {
    IN_APP: inAppProvider(),
    EMAIL: email,
    TELEGRAM: unconfiguredProvider('TELEGRAM', 'нет токена'),
  } as const;
  return {
    byChannel,
    liveChannels: (['IN_APP', 'EMAIL', 'TELEGRAM'] as const).filter((c) => byChannel[c].configured),
  };
}

const service = (email: DeliveryProvider) =>
  new DeliveryService(db, notifications, retention, providerSet(email));

async function queueFor(userId: string, channels: readonly ('EMAIL' | 'IN_APP' | 'TELEGRAM')[] = ['EMAIL']) {
  await notifications.enqueue({
    userId,
    category: 'BOOKING_REQUEST',
    dedupeKey: `test:${uuidv7()}`,
    channels,
  });
}

/* Registration itself enqueues a welcome notification, so every query and
   every provider assertion here is scoped to the rows this suite created. A
   count that silently included the welcome message would make several of these
   tests pass for the wrong reason. */
const statusOf = async (userId: string, channel = 'EMAIL') => {
  const { rows } = await db.query<{ status: string; attempts: number; next_attempt_at: Date | null }>(
    `SELECT status, attempts, next_attempt_at FROM notification
      WHERE user_id=$1 AND channel=$2 AND dedupe_key LIKE 'test:%'`,
    [userId, channel],
  );
  return rows[0]!;
};

/** Only the sends this suite queued. */
const testSends = (p: { sent: DeliveryMessage[] }) => p.sent.filter((m) => m.category === 'BOOKING_REQUEST');

/* ================================================================== *
 * Delivery
 * ================================================================== */

describe('delivery', () => {
  it('sends a queued notification and records it once', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(delivered('250 ok')));

    const report = await service(email).run();
    expect(report.delivered).toBeGreaterThanOrEqual(1);
    expect(testSends(email).length).toBe(1);
    expect((await statusOf(user.userId)).status).toBe('SENT');
  });

  it('resolves the address now, from the user record, not from the payload', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));
    await service(email).run();
    // The address is the account's current email — so a corrected address takes
    // effect on everything still queued, and a payload cannot misdirect.
    expect(email.sent[0]!.address).toBe(user.email);
  });

  it('never leaks the recipient of one person to another', async () => {
    const a = await api.signUp();
    const b = await api.signUp();
    await queueFor(a.userId);
    await queueFor(b.userId);

    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));
    await service(email).run();

    for (const m of testSends(email)) {
      const expected = m.userId === a.userId ? a.email : b.email;
      expect(m.address).toBe(expected);
    }
  });

  it('a second run has nothing left to do', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));

    await service(email).run();
    await service(email).run();
    // Delivered exactly once, not once per run.
    expect(testSends(email).length).toBe(1);
  });

  it('two concurrent runs do the work once', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));
    const svc = service(email);

    // The job_run mutex turns the second runner away entirely.
    const first = await retention.beginRun('notification.deliver', null, 5);
    expect(first).toBeTruthy();
    const report = await svc.run();
    expect(report.runId).toBeNull();
    expect(testSends(email).length).toBe(0);
  });

  /* The claim must be exclusive at the row level too, not only at the job
     level — otherwise a future design with two workers would double-send. */
  it('claiming twice yields the row only once', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);

    const firstClaim = await notifications.claimForDelivery(['EMAIL'], 50);
    const secondClaim = await notifications.claimForDelivery(['EMAIL'], 50);
    expect(firstClaim.filter((r) => r.category === 'BOOKING_REQUEST').length).toBe(1);
    expect(secondClaim.filter((r) => r.category === 'BOOKING_REQUEST').length).toBe(0);
  });
});

/* ================================================================== *
 * Failure handling
 * ================================================================== */

describe('failure handling', () => {
  it('a transient failure retries later, with a backoff', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(transient('timeout')));

    const report = await service(email).run();
    expect(report.retrying).toBeGreaterThanOrEqual(1);

    const row = await statusOf(user.userId);
    expect(row.status).toBe('PENDING');
    expect(row.next_attempt_at).toBeTruthy();
    // The whole point: it is not re-sent on the very next run.
    await service(email).run();
    expect(testSends(email).length).toBe(1);
  });

  it('the backoff escalates rather than retrying at a fixed interval', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(transient('timeout')));
    const svc = service(email);

    const gaps: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const now = new Date(Date.now() + i * 86_400_000);
      await svc.run({ now });
      const row = await statusOf(user.userId);
      if (row.next_attempt_at) gaps.push(new Date(row.next_attempt_at).getTime() - now.getTime());
      // Let the row become claimable again for the next iteration.
      await db.query(
        `UPDATE notification SET next_attempt_at = NULL WHERE user_id=$1 AND dedupe_key LIKE 'test:%'`,
        [user.userId],
      );
    }
    expect(gaps.length).toBe(3);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!);
  });

  it('a permanent failure is not retried', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(permanent('550 no such mailbox')));

    const report = await service(email).run();
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect((await statusOf(user.userId)).status).toBe('FAILED');

    await service(email).run();
    // Retrying an address the provider rejected is pure cost, and at scale an
    // accidental attack on somebody who already said no.
    expect(testSends(email).length).toBe(1);
  });

  it('gives up after the attempt ceiling', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => Promise.resolve(transient('timeout')));
    const svc = service(email);

    for (let i = 0; i < 8; i += 1) {
      await db.query(
        `UPDATE notification SET next_attempt_at = NULL WHERE user_id=$1 AND dedupe_key LIKE 'test:%'`,
        [user.userId],
      );
      await svc.run();
    }
    expect((await statusOf(user.userId)).status).toBe('FAILED');
  });

  /* The invariant that makes the whole thing trustworthy: there is no path to
     SENT except a provider actually reporting DELIVERED. */
  it('never records SENT without a delivery', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    for (const outcome of [transient('t'), permanent('p')]) {
      await db.query(
        `UPDATE notification SET status='PENDING', next_attempt_at=NULL
          WHERE user_id=$1 AND dedupe_key LIKE 'test:%'`,
        [user.userId],
      );
      await service(spyProvider('EMAIL', () => Promise.resolve(outcome))).run();
      expect((await statusOf(user.userId)).status).not.toBe('SENT');
    }
  });

  it('an unexpected throw is treated as transient, not lost', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const email = spyProvider('EMAIL', () => {
      throw new Error('socket exploded');
    });

    const report = await service(email).run();
    expect(report.retrying).toBeGreaterThanOrEqual(1);
    expect((await statusOf(user.userId)).status).toBe('PENDING');
  });

  it('reclaims a row a dead worker never settled', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    await notifications.claimForDelivery(['EMAIL'], 50);
    await db.query(
      `UPDATE notification SET claimed_at = now() - interval '30 minutes' WHERE user_id=$1`,
      [user.userId],
    );

    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));
    const report = await service(email).run();
    // At-least-once: the send may or may not have happened, and never
    // delivering a security notice is worse than delivering twice.
    expect(report.reclaimed).toBeGreaterThanOrEqual(1);
    expect(testSends(email).length).toBe(1);
  });
});

/* ================================================================== *
 * Channels the deployment cannot reach
 * ================================================================== */

describe('unconfigured channels', () => {
  it('are never claimed, so the backlog stays honest', async () => {
    const user = await api.signUp();
    await db.query(
      `INSERT INTO notification_preference (user_id, category, channel, enabled) VALUES ($1,'BOOKING_REQUEST','TELEGRAM',true)`,
      [user.userId],
    );
    await db.query(
      `INSERT INTO telegram_connection (user_id, telegram_chat_id) VALUES ($1, 12345)`,
      [user.userId],
    );
    await queueFor(user.userId, ['TELEGRAM']);

    await service(spyProvider('EMAIL', () => Promise.resolve(delivered()))).run();

    // Still PENDING, not FAILED: when a provider is eventually configured the
    // backlog goes out, and until then queue depth is the honest measure.
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM notification WHERE user_id=$1 AND channel='TELEGRAM'`,
      [user.userId],
    );
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('the default deployment reports that it can send nothing external', async () => {
    const svc = new DeliveryService(db, notifications, retention);
    const channels = svc.describeChannels();
    expect(channels.EMAIL).toContain('не задан');
    expect(channels.TELEGRAM).toContain('не задан');
    // IN_APP is genuinely real — the row IS the message.
    expect(channels.IN_APP).toContain('личном кабинете');
  });

  it('an account with no address for the channel is suppressed, not failed', async () => {
    // A phone-only account: app_user requires email OR phone, not both.
    const id = uuidv7();
    await db.query(
      `INSERT INTO app_user (id, phone, display_name, password_hash) VALUES ($1,'+375291112233','Тэлефон','x')`,
      [id],
    );
    await queueFor(id);

    const email = spyProvider('EMAIL', () => Promise.resolve(delivered()));
    const report = await service(email).run();

    expect(testSends(email).length).toBe(0);
    expect(report.suppressed).toBe(1);
    expect((await statusOf(id)).status).toBe('SUPPRESSED');
  });
});

/* ================================================================== *
 * Authorization
 * ================================================================== */

describe('who may run delivery', () => {
  it('ADMIN may; an ordinary account may not', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const user = await api.signUp();

    expect((await api.post('/admin/notifications/run', {}, { token: admin.token })).status).toBe(200);
    expect((await api.post('/admin/notifications/run', {}, { token: user.token })).status).toBe(403);
  });

  it('the backlog never contains a message body or an address', async () => {
    const user = await api.signUp();
    await queueFor(user.userId);
    const support = await api.signUp();
    await api.grantRole(support.userId, 'SUPPORT');

    const res = await api.get('/admin/notifications/backlog', { token: support.token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(user.email);
  });
});

/* ================================================================== *
 * Booking expiry
 * ================================================================== */

describe('booking expiry', () => {
  const LISTING = {
    title: 'Светлая двушка у метро Немига',
    propertyType: 'APARTMENT' as const,
    city: 'Минск',
    latitude: 53.9045,
    longitude: 27.5615,
    rooms: 2,
    beds: 3,
    maxGuests: 4,
    basePriceMinor: '10000',
    cleaningFeeMinor: '0',
    depositMinor: '0',
    minNights: 2,
    maxNights: 90,
    bookingMode: 'REQUEST' as const,
    amenities: ['WIFI'],
  };

  async function pendingRequest() {
    await db.execScript(`
      INSERT INTO amenity (code, category, name_ru, name_be, name_en)
      VALUES ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi') ON CONFLICT DO NOTHING;`);

    const landlord = await api.signUp();
    const created = await api.post('/listings', LISTING, { token: landlord.token });
    const listingId = created.body.id as string;
    await api.attachPhoto(listingId);
    await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

    const moderator = await api.signUp();
    await api.grantRole(moderator.userId, 'MODERATOR');
    await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, { token: moderator.token });

    const tenant = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2027-09-15', to: '2027-09-20' },
      { token: tenant.token },
    );
    if (!booking.body?.id) throw new Error(`booking failed: ${booking.status} ${JSON.stringify(booking.body)}`);
    return { landlord, tenant, bookingId: booking.body.id as string };
  }

  const bookingStatus = async (id: string) => {
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [id]);
    return rows[0]!.status;
  };

  it('closes a request nobody answered', async () => {
    const { bookingId } = await pendingRequest();
    expect(await bookingStatus(bookingId)).toBe('REQUESTED');

    // The response window elapsed.
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);

    const bookings = new BookingService(db);
    expect(await bookings.dueForExpiry()).toContain(bookingId);
    await bookings.expireStale(bookingId);
    expect(await bookingStatus(bookingId)).toBe('EXPIRED');
  });

  it('leaves a request whose window has not elapsed', async () => {
    const { bookingId } = await pendingRequest();
    const bookings = new BookingService(db);
    expect(await bookings.dueForExpiry()).not.toContain(bookingId);
  });

  it('writes an event and an audit row attributed to the job', async () => {
    const { bookingId } = await pendingRequest();
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    await new BookingService(db).expireStale(bookingId);

    const events = await db.query<{ event_type: string; actor: string }>(
      `SELECT event_type, actor FROM booking_event WHERE booking_id=$1 AND event_type='EXPIRE'`,
      [bookingId],
    );
    expect(events.rows[0]!.actor).toBe('SYSTEM');

    const audit = await db.query<{ source: string }>(
      `SELECT source FROM audit_log WHERE target_id=$1 AND action='booking.expire'`,
      [bookingId],
    );
    expect(audit.rows[0]!.source).toBe('job');
  });

  it('is idempotent — a second pass changes nothing', async () => {
    const { bookingId } = await pendingRequest();
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    const bookings = new BookingService(db);

    await bookings.expireStale(bookingId);
    await bookings.expireStale(bookingId);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM booking_event WHERE booking_id=$1 AND event_type='EXPIRE'`,
      [bookingId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  /* A lost race must be a no-op, not a failure. Without the status guard,
     applyEvent throws, the sweep records a failure, and finishRun marks the run
     FAILED — turning an ordinary correct outcome red and training whoever reads
     the dashboard to ignore the colour. */
  it('an already-accepted booking is a no-op, not an error', async () => {
    const { landlord, bookingId } = await pendingRequest();
    await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
    expect(await bookingStatus(bookingId)).toBe('CONFIRMED');

    const after = await new BookingService(db).expireStale(bookingId);
    expect(after.status).toBe('CONFIRMED');
  });

  it('accepting an already-expired request is refused with a usable error', async () => {
    const { landlord, bookingId } = await pendingRequest();
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    await new BookingService(db).expireStale(bookingId);

    const res = await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
    expect(res.status).toBe(409);
  });

  it('the lifecycle sweep expires requests and tells both sides', async () => {
    const { bookingId, tenant, landlord } = await pendingRequest();
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);

    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const res = await api.post('/admin/lifecycle/run', {}, { token: admin.token });

    expect(res.status).toBe(200);
    expect(res.body.requestsExpired).toContain(bookingId);
    expect(await bookingStatus(bookingId)).toBe('EXPIRED');

    for (const userId of [tenant.userId, landlord.userId]) {
      const { rows } = await db.query<{ c: string }>(
        `SELECT count(*)::text c FROM notification WHERE user_id=$1 AND dedupe_key LIKE 'booking-expired:%'`,
        [userId],
      );
      expect(Number(rows[0]!.c)).toBeGreaterThan(0);
    }
  });

  it('running the sweep twice does not expire twice or notify twice', async () => {
    const { bookingId, tenant } = await pendingRequest();
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');

    await api.post('/admin/lifecycle/run', {}, { token: admin.token });
    await api.post('/admin/lifecycle/run', {}, { token: admin.token });

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM notification
        WHERE user_id=$1 AND dedupe_key LIKE 'booking-expired:%' AND channel='IN_APP'`,
      [tenant.userId],
    );
    // The dedupe key does the work: one business event, one message.
    expect(rows[0]!.c).toBe('1');
  });
});
