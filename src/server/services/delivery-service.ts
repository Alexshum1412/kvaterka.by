/**
 * The notification delivery worker.
 *
 * WHAT WAS MISSING. `claimPending`, `markSent` and `markFailed` have existed in
 * NotificationService since the notification slice and were called from
 * nowhere. Twenty-five places in the product enqueue notifications; nothing
 * drained them. Every notification the platform has ever produced is still
 * PENDING, which means a landlord has never been told their flat was booked,
 * and a tenant has never been asked to confirm a stay. The producers were
 * complete and the consumer did not exist.
 *
 * ORDERING: CLAIM → SEND → SETTLE.
 *
 * The same shape as the retention purge, for the same reason: an external
 * effect and a database write cannot be one transaction, so the order is
 * decided by which failure is recoverable.
 *
 *   claim   — one short transaction moves the row to SENDING. Exclusive.
 *   send    — the provider call, with NO transaction open. Holding a pooled
 *             connection across a network call to somebody else's SMTP server
 *             is how a delivery job takes the site down.
 *   settle  — SENT, or PENDING with a backoff, or FAILED.
 *
 * A crash between send and settle leaves the row SENDING; the lease reclaims it
 * and it is sent again. That is AT-LEAST-ONCE and it is deliberate: this system
 * cannot promise exactly-once, because no provider it will ever talk to can
 * confirm receipt atomically with our commit. Delivering a message twice is a
 * nuisance. Never delivering a security notice is not. Saying "exactly once"
 * here would be a claim about somebody else's infrastructure.
 */

import { type Db } from '../db/sql.ts';
import { NOTIFICATION_CATEGORY_TITLE, type Channel, type NotificationService } from './notification-service.ts';
import { resolveProviders, type ProviderSet } from '../delivery/provider.ts';
import { writeAudit } from './audit.ts';
import type { RetentionService } from './retention-service.ts';

export const DELIVERY_JOB = 'notification.deliver';

/**
 * A delivery run is short. If one is still marked RUNNING after this, the
 * process that claimed it is gone, and an hour of silence on security and
 * booking notifications is worse than the small chance of an overlap.
 */
const DELIVERY_LEASE_MINUTES = 5;

export interface DeliveryReport {
  readonly job: string;
  readonly runId: string | null;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly reclaimed: number;
  readonly channels: Record<string, string>;
  readonly notes: string[];
}

export class DeliveryService {
  private readonly providers: ProviderSet;

  constructor(
    private readonly db: Db,
    private readonly notifications: NotificationService,
    private readonly jobs: RetentionService,
    providers?: ProviderSet,
  ) {
    this.providers = providers ?? resolveProviders();
  }

  /** What this deployment can actually reach. Shown in the console. */
  /**
   * The channels this deployment can actually reach.
   *
   * Exposed so a settings screen never offers a switch for a transport that
   * would do nothing — the provider's own `configured` flag is the only
   * honest source for that, and it is deliberately false for a channel whose
   * credentials exist but whose client does not.
   */
  liveChannels(): readonly Channel[] {
    return this.providers.liveChannels;
  }

  describeChannels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [channel, provider] of Object.entries(this.providers.byChannel)) {
      out[channel] = provider.describe();
    }
    return out;
  }

  /**
   * One pass over the outbox.
   *
   * Each notification is isolated: one that throws must not abandon the batch,
   * because the next run would find it first and stall on it for ever.
   */
  async run(opts: { now?: Date; limit?: number; triggeredBy?: string | null } = {}): Promise<DeliveryReport> {
    const now = opts.now ?? new Date();
    const runId = await this.jobs.beginRun(DELIVERY_JOB, opts.triggeredBy ?? null, DELIVERY_LEASE_MINUTES);

    if (!runId) {
      return {
        job: DELIVERY_JOB,
        runId: null,
        delivered: 0,
        retrying: 0,
        failed: 0,
        suppressed: 0,
        reclaimed: 0,
        channels: this.describeChannels(),
        notes: ['Рассылка уже выполняется — этот запуск ничего не делал.'],
      };
    }

    let delivered = 0;
    let retrying = 0;
    let failed = 0;
    let suppressed = 0;
    let reclaimed = 0;
    const notes: string[] = [];

    try {
      // Rows a dead worker left behind, before claiming anything new.
      reclaimed = await this.notifications.reclaimAbandoned(DELIVERY_LEASE_MINUTES);

      const live = this.providers.liveChannels;
      if (live.length === 0) {
        notes.push('Ни один канал доставки не настроен — ничего не отправлено.');
      }

      const batch = await this.notifications.claimForDelivery(live, opts.limit ?? 50, now);

      for (const item of batch) {
        try {
          const outcome = await this.deliverOne(item, now);
          if (outcome === 'DELIVERED') delivered += 1;
          else if (outcome === 'SUPPRESSED') suppressed += 1;
          else if (outcome === 'FAILED') failed += 1;
          else retrying += 1;
        } catch (e) {
          // An unexpected throw is treated as transient: the row goes back with
          // a backoff rather than being lost or retried instantly.
          await this.notifications.markFailed(
            item.id,
            e instanceof Error ? e.message : 'unexpected',
            'TRANSIENT',
            now,
          );
          retrying += 1;
        }
      }

      for (const channel of Object.keys(this.providers.byChannel) as Channel[]) {
        const provider = this.providers.byChannel[channel];
        if (!provider.configured) notes.push(provider.describe());
      }
    } finally {
      await this.jobs.finishRun(runId, {
        processed: delivered,
        skipped: suppressed,
        failed,
        detail: { retrying, reclaimed, channels: this.describeChannels() },
      });
    }

    return {
      job: DELIVERY_JOB,
      runId,
      delivered,
      retrying,
      failed,
      suppressed,
      reclaimed,
      channels: this.describeChannels(),
      notes,
    };
  }

  /* ---------------------------------------------------------------- */

  private async deliverOne(
    item: { id: string; user_id: string; category: string; channel: Channel; payload: Record<string, unknown> },
    now: Date,
  ): Promise<'DELIVERED' | 'RETRY' | 'FAILED' | 'SUPPRESSED'> {
    const provider = this.providers.byChannel[item.channel];

    /* Where it goes is resolved NOW, from the user's current record — never
       from the payload. A payload written last week would carry an address the
       person has since corrected, and would keep sending to a Telegram chat
       they have since unlinked. Resolving late is also what makes withdrawal
       of consent take effect on everything still queued. */
    const address = await this.notifications.resolveAddress(item.user_id, item.channel);
    if (!address) {
      // Not a failure of delivery — there is nowhere to deliver. A phone-only
      // account has no email address, and `app_user` requires only one of the
      // two, so this is an ordinary state rather than an error.
      await this.notifications.markSuppressed(item.id, 'Адрес для этого канала отсутствует');
      return 'SUPPRESSED';
    }

    const result = await provider.send({
      notificationId: item.id,
      userId: item.user_id,
      channel: item.channel,
      address,
      category: item.category,
      subject: NOTIFICATION_CATEGORY_TITLE[item.category] ?? 'Кватэрка.by',
      body: renderBody(item.category, item.payload),
    });

    if (result.status === 'DELIVERED') {
      await this.notifications.markSent(item.id, result.detail);
      return 'DELIVERED';
    }

    if (result.status === 'PERMANENT') {
      await this.notifications.markFailed(item.id, result.detail, 'PERMANENT', now);
      // Worth an audit row: a permanently undeliverable security notice is
      // something a person should eventually be told about by another means.
      await this.db.transaction(async (tx) => {
        await writeAudit(tx, {
          actorUserId: null,
          actorRole: 'job',
          action: 'notification.undeliverable',
          targetType: 'notification',
          targetId: item.id,
          changes: { channel: { from: null, to: item.channel } },
          reason: result.detail,
          source: 'job',
        });
      });
      return 'FAILED';
    }

    await this.notifications.markFailed(item.id, result.detail, 'TRANSIENT', now);
    return 'RETRY';
  }
}

/**
 * The message text.
 *
 * Deliberately spare. Everything here leaves the platform and lands with a
 * third party — an SMTP relay, Telegram's servers — so it says that something
 * happened and where to look, and nothing about who, which flat, or how much.
 * The detail lives behind a login, which is also where the person can see it
 * in context rather than as a fragment in a notification.
 */
function renderBody(category: string, payload: Record<string, unknown>): string {
  const title = NOTIFICATION_CATEGORY_TITLE[category] ?? 'Обновление';
  const where = typeof payload.bookingId === 'string' ? '/trips' : '/dashboard';
  return `${title}. Откройте Кватэрка.by, чтобы посмотреть: ${where}`;
}
