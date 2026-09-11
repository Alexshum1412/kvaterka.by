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
import { renderEmailHtml } from '../delivery/email-template.ts';
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
  /**
   * Origin used for the two links this service ever writes into a message body
   * (email verification, password reset). Read once, here, the same way
   * `resolveProviders()` reads its channel credentials — never inside
   * `renderBody()` itself, so a mid-run environment change cannot make one
   * batch's links inconsistent with the next.
   *
   * NOT a second default: `runtime.ts` already validates and defaults
   * `PUBLIC_BASE_URL` (`z.string().url().default('http://localhost:3000')`),
   * and a malformed value stops the process at boot everywhere else in this
   * codebase. `container.ts` passes that already-resolved value straight
   * through, so a bad URL fails the same way here instead of quietly
   * producing a broken verification link. The literal below exists only for
   * the two test call sites that construct this class directly and have no
   * reason to care what the link's origin is.
   */
  private readonly publicBaseUrl: string;

  constructor(
    private readonly db: Db,
    private readonly notifications: NotificationService,
    private readonly jobs: RetentionService,
    providers?: ProviderSet,
    publicBaseUrl = 'http://localhost:3000',
  ) {
    this.providers = providers ?? resolveProviders();
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
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
   * Send a registration code immediately, bypassing the queue.
   *
   * Every other notification in this product enqueues and lets the worker
   * drain it, because the queue is what keeps a failing SMTP relay from
   * rolling back a booking. A registration code has nothing to roll back —
   * there is no `app_user` row yet to hang a queued `notification` on, only
   * `pending_registration` — so this is the one message sent directly.
   * Returns whether it actually left the building rather than throwing: the
   * code already exists in `pending_registration` either way, and "resend"
   * is the recovery path, not an exception bubbling into a 500.
   */
  async sendRegistrationCode(address: string, code: string, identifier: string): Promise<boolean> {
    const provider = this.providers.byChannel.EMAIL;
    const payload = { kind: 'REGISTRATION_CODE', code, identifier };
    const subject = NOTIFICATION_CATEGORY_TITLE.SECURITY!;
    const body = renderBody('SECURITY', payload, this.publicBaseUrl);
    const html = renderEmailHtml(subject, body, emailCta(payload, this.publicBaseUrl));

    const result = await provider.send({
      notificationId: `pending-registration:${identifier}`,
      userId: '',
      channel: 'EMAIL',
      address,
      category: 'SECURITY',
      subject,
      body,
      html,
    });
    return result.status === 'DELIVERED';
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

    const subject = NOTIFICATION_CATEGORY_TITLE[item.category] ?? 'Кватэрка.by';
    const body = renderBody(item.category, item.payload, this.publicBaseUrl);

    /* HTML is EMAIL-only. TELEGRAM's Bot API takes plain text (its own
       entity syntax, not HTML5), and IN_APP already renders `body` inside
       the inbox's own layout — an `html` field on either would be either
       ignored or, worse, shown as literal markup. */
    const html =
      item.channel === 'EMAIL'
        ? renderEmailHtml(subject, body, emailCta(item.payload, this.publicBaseUrl))
        : undefined;

    const result = await provider.send({
      notificationId: item.id,
      userId: item.user_id,
      channel: item.channel,
      address,
      category: item.category,
      subject,
      body,
      ...(html !== undefined ? { html } : {}),
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
 *
 * REGISTRATION_CODE and PASSWORD_RESET are the one exception, not a crack in
 * that rule. There is no account detail to leak in either — the entire message
 * IS a one-time secret, and without it the feature does not work at all. Both
 * are still SECURITY, still spare, still second person; they just carry the
 * code or link the whole notification exists to deliver. Everything else falls
 * through to the generic body unchanged.
 *
 * Exported only so a test can call it directly rather than driving a whole
 * `DeliveryService` through a database to observe one string.
 */
export function renderBody(category: string, payload: Record<string, unknown>, publicBaseUrl: string): string {
  const link = tokenLink(payload, publicBaseUrl);
  if (link?.kind === 'REGISTRATION_CODE') {
    const code = typeof payload.code === 'string' ? payload.code : '';
    return `Код подтверждения: ${code} (действует 30 минут). Либо перейдите по ссылке: ${link.url}`;
  }
  if (link?.kind === 'PASSWORD_RESET') {
    return `Чтобы задать новый пароль, перейдите по ссылке: ${link.url}`;
  }

  const title = NOTIFICATION_CATEGORY_TITLE[category] ?? 'Обновление';
  const where = typeof payload.bookingId === 'string' ? '/trips' : '/dashboard';
  return `${title}. Откройте Кватэрка.by, чтобы посмотреть: ${where}`;
}

/**
 * The one-time link a token-carrying payload resolves to, if it has one.
 *
 * Factored out of `renderBody` so the HTML email's CTA button (`emailCta`
 * below) builds the exact same URL from the exact same branch, rather than a
 * second, slightly different copy of this logic that could point the button
 * and the paragraph beside it at different links.
 */
function tokenLink(
  payload: Record<string, unknown>,
  publicBaseUrl: string,
): { kind: 'REGISTRATION_CODE' | 'PASSWORD_RESET'; url: string } | null {
  if (payload.kind === 'REGISTRATION_CODE') {
    const code = typeof payload.code === 'string' ? payload.code : null;
    const identifier = typeof payload.identifier === 'string' ? payload.identifier : null;
    if (!code || !identifier) return null;
    // The link carries the same code as a query param, so clicking it and
    // typing the code by hand are the exact same act of proving control of
    // the inbox — not two mechanisms with two different secrets to manage.
    return {
      kind: 'REGISTRATION_CODE',
      url: `${publicBaseUrl}/verify-email?identifier=${encodeURIComponent(identifier)}&code=${encodeURIComponent(code)}`,
    };
  }
  const token = typeof payload.token === 'string' ? payload.token : null;
  if (!token) return null;
  if (payload.kind === 'PASSWORD_RESET') {
    return { kind: 'PASSWORD_RESET', url: `${publicBaseUrl}/password-reset?token=${token}` };
  }
  return null;
}

/**
 * The HTML email's call-to-action, when the category has one.
 *
 * Only REGISTRATION_CODE and PASSWORD_RESET carry a deep link today — the
 * same exception `renderBody`'s own doc comment names. Everything else
 * renders with no button, deliberately: inventing a per-category deep link
 * here (say, a guess at a booking's URL) would be a second router this file
 * has no business owning.
 */
function emailCta(
  payload: Record<string, unknown>,
  publicBaseUrl: string,
): { ctaUrl?: string; ctaLabel?: string; code?: string } {
  const link = tokenLink(payload, publicBaseUrl);
  if (link?.kind === 'REGISTRATION_CODE') {
    const code = typeof payload.code === 'string' ? payload.code : undefined;
    return { ctaUrl: link.url, ctaLabel: 'Подтвердить почту', code };
  }
  if (link?.kind === 'PASSWORD_RESET') return { ctaUrl: link.url, ctaLabel: 'Сбросить пароль' };
  return {};
}
